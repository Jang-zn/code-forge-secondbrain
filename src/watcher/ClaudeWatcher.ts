import * as chokidar from 'chokidar';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { JsonlParser } from '../parser/JsonlParser';
import type { ParsedMessage } from '../parser/types';
import { ProcessedState } from '../state/ProcessedState';
import { GeminiSummarizer } from '../summarizer/GeminiSummarizer';
import { ClaudeCLISummarizer } from '../summarizer/ClaudeCLISummarizer';
import { buildPreviousContextSection } from '../summarizer/summaryUtils';
import { VaultIndex } from '../vault/VaultIndex';
import { LinkMatcher } from '../vault/LinkMatcher';
import { NoteWriter } from '../vault/NoteWriter';
import { FileLock } from '../state/FileLock';
import type { Config, ApiKeyManager } from '../config';
import type { StatusBar } from '../ui/StatusBar';
import type { Logger } from '../ui/Logger';

const CLAUDE_PROJECTS_PATH = path.join(os.homedir(), '.claude', 'projects');

function isSubagentFile(filePath: string): boolean {
  return filePath.includes('/subagents/') || filePath.includes('\\subagents\\');
}

/** ~/.claude/projects/<encoded-project-path>/<file>.jsonl 에서 프로젝트명 추출 */
function projectFromPath(filePath: string): string {
  // chokidar는 Windows에서도 forward slash를 반환할 수 있으므로 양쪽 구분자로 split
  const parts = filePath.split(/[\\/]/);
  const projectsIdx = parts.lastIndexOf('projects');
  return (projectsIdx >= 0 && parts[projectsIdx + 1]) ? parts[projectsIdx + 1] : path.basename(path.dirname(filePath));
}

/**
 * fsPath를 Claude CLI의 projects 폴더 인코딩 방식으로 변환.
 * / \ → -, : 제거, 결과가 -로 시작하지 않으면 앞에 - 추가.
 * 예: "/Users/jang/projects/my-app" → "-Users-jang-projects-my-app"
 * 예: "C:\Users\user\projects\my-app" → "-C-Users-user-projects-my-app"
 */
function encodePathForClaude(fsPath: string): string {
  const normalized = fsPath.replace(/:/g, '').replace(/[/\\]/g, '-');
  return normalized.startsWith('-') ? normalized : '-' + normalized;
}

export class ClaudeWatcher implements vscode.Disposable {
  private watcher: chokidar.FSWatcher | null = null;
  private dirtyFiles = new Set<string>();
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private parser = new JsonlParser();
  private state: ProcessedState;
  private vaultIndex = new VaultIndex();
  private noteWriter = new NoteWriter();
  private fileLock = new FileLock();
  private inFlight = new Set<string>();
  /** Set while processCurrent() batch is running to pause the scheduler */
  private batchInProgress = false;

  constructor(
    private config: Config,
    private apiKeyManager: ApiKeyManager,
    private statusBar: StatusBar,
    private logger?: Logger,
    private resolvedBinary?: string
  ) {
    this.state = new ProcessedState();
  }

  async start(): Promise<void> {
    // 멱등성 보장: 이미 실행 중이면 기존 리소스 정리 후 재시작
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }

    const watchPath = CLAUDE_PROJECTS_PATH;
    if (!fs.existsSync(watchPath)) {
      this.logger?.warn('감시 미시작: ~/.claude/projects 폴더 없음', { 경로: watchPath });
      return;
    }

    this.logger?.info('감시 시작', { 경로: watchPath });

    // chokidar glob requires forward slashes even on Windows
    const globPattern = watchPath.replace(/\\/g, '/') + '/**/*.jsonl';

    // Watcher를 먼저 시작해서 초기화 중 발생하는 add/change 이벤트를 놓치지 않도록 함
    this.watcher = chokidar.watch(globPattern, {
      ignoreInitial: true,
      ignored: '**/subagents/**',
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      persistent: true,
    });

    this.watcher.on('add', (filePath) => this.onFileAdd(filePath));
    this.watcher.on('change', (filePath) => this.onFileChange(filePath));
    this.watcher.on('error', (err: Error) => {
      this.logger?.error('파일 감시 오류', { 오류: err.message });
    });

    // Watcher 활성 후 초기화: seed는 hasEntry 체크로 기존 파일만 처리하므로
    // watcher가 수집한 dirtyFiles와 충돌하지 않음
    try {
      await this.initializeExistingFiles(watchPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error('초기화 실패', { 오류: msg });
    }

    this.startScheduler();
  }

  private async initializeExistingFiles(watchPath: string): Promise<void> {
    const toSeed: Array<{ filePath: string; mtime: number; messageCount: number }> = [];
    const toProcess: string[] = [];
    for (const filePath of findJsonlFiles(watchPath).filter(f => !isSubagentFile(f))) {
      // watcher가 이미 감지한 파일은 seed하지 않음 — dirtyFiles가 우선 (매번 실시간 체크)
      if (this.dirtyFiles.has(filePath)) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(filePath); } catch { continue; }
      if (!this.state.hasEntry(filePath)) {
        // New file with no state — seed to prevent bulk-processing on fresh install
        const session = this.parser.parse(filePath);
        toSeed.push({ filePath, mtime: stat.mtimeMs, messageCount: session?.messages.length ?? 0 });
      } else if (this.state.shouldProcess(filePath, stat.mtimeMs)) {
        // Existing entry with changed mtime — queue as dirty for next scheduled slot
        toProcess.push(filePath);
      }
    }
    // seedFiles 직전에도 dirty 체크: seed 후보 중 그 사이 dirty가 된 파일 제외
    const filteredSeed = toSeed.filter(s => !this.dirtyFiles.has(s.filePath));
    await this.state.seedFiles(filteredSeed);
    for (const filePath of toProcess) {
      this.dirtyFiles.add(filePath);
    }
    this.logger?.info('초기화 완료', { 등록: filteredSeed.length, 대기: toProcess.length });
  }

  private onFileAdd(newFilePath: string): void {
    if (!this.config.enabled) return;
    if (this.isExcludedProject(newFilePath)) return;

    // New file = new session started — add sibling files to dirty set for next slot
    const projectDir = path.dirname(newFilePath);
    const siblings = findJsonlFiles(projectDir).filter(f => f !== newFilePath && !isSubagentFile(f));
    for (const sibling of siblings) {
      this.dirtyFiles.add(sibling);
    }
    this.dirtyFiles.add(newFilePath);
  }

  private onFileChange(filePath: string): void {
    if (!this.config.enabled) return;
    if (this.isExcludedProject(filePath)) return;
    this.dirtyFiles.add(filePath);
  }

  private startScheduler(): void {
    this.logger?.info('스케줄러 시작', { 간격: '20분' });
    const schedule = () => {
      const ms = msUntilNextSlot();
      this.schedulerTimer = setTimeout(async () => {
        await this.runScheduled();
        schedule(); // 다음 슬롯 재귀 예약
      }, ms);
    };
    schedule();
  }

  private async runScheduled(): Promise<void> {
    // Don't run while processCurrent() batch is in progress
    if (this.batchInProgress) return;

    // Periodic GC: remove state entries for deleted .jsonl files (at most once per day)
    if (this.state.needsGc()) {
      await this.state.gcStaleEntries().catch((err: unknown) => {
        this.logger?.warn('GC 실패', { 오류: err instanceof Error ? err.message : String(err) });
      });
    }

    const files = Array.from(this.dirtyFiles);
    this.dirtyFiles.clear();
    if (files.length > 0) {
      this.logger?.info('스케줄러 실행', { 대상파일: files.length });
    }
    for (const filePath of files) {
      await this.processFile(filePath);
    }
    if (files.length > 0) {
      this.logger?.printStats();
    }
  }

  async processFile(filePath: string, manual = false, forceReprocess = false, batch = false, signal?: AbortSignal): Promise<void> {
    const project = projectFromPath(filePath);
    if (this.inFlight.has(filePath)) {
      if (manual && !batch) {
        vscode.window.showInformationMessage('SecondBrain: 이미 처리 중입니다.');
      } else {
        this.logger?.skip('이미 처리 중', { project });
      }
      return;
    }
    if (!this.config.isValid()) {
      if (manual && !batch) {
        vscode.window.showWarningMessage('SecondBrain: Vault 경로가 설정되지 않았습니다. Setup 명령을 실행하세요.');
      } else {
        this.logger?.skip('Vault 경로 미설정', { project });
      }
      return;
    }

    this.inFlight.add(filePath);
    try {
      await this._processFile(filePath, manual, forceReprocess, batch, signal);
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  private async _processFile(filePath: string, manual = false, forceReprocess = false, batch = false, signal?: AbortSignal): Promise<void> {
    const project = projectFromPath(filePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      if (manual && !batch) {
        vscode.window.showWarningMessage('SecondBrain: 대화 파일을 읽을 수 없습니다.');
      } else {
        this.logger?.skip('파일 읽기 실패', { project });
      }
      return;
    }

    if (!forceReprocess && !this.state.shouldProcess(filePath, stat.mtimeMs)) {
      if (manual && !batch) {
        vscode.window.showInformationMessage('SecondBrain: 변경된 내용이 없습니다.');
      } else {
        this.logger?.skip('변경 없음', { project });
      }
      return;
    }

    if (!(await this.fileLock.acquire(filePath))) {
      if (manual && !batch) {
        vscode.window.showInformationMessage('SecondBrain: 다른 창에서 처리 중입니다.');
      } else {
        this.logger?.skip('락 점유 중 (다른 창)', { project });
      }
      return;
    }

    try {
      this.state.reload();

      if (forceReprocess) {
        const entry = this.state.getAllEntries()[filePath];
        if (entry?.processedAt) {
          const age = Date.now() - new Date(entry.processedAt).getTime();
          if (age < 30_000) {
            if (manual && !batch) {
              vscode.window.showInformationMessage('SecondBrain: 최근에 이미 처리되었습니다.');
            } else {
              this.logger?.skip('30초 이내 재처리 방지', { project });
            }
            return;
          }
        }
        await this.state.resetEntry(filePath);
      }

      // Re-stat after lock to avoid stale mtime from pre-lock read
      try {
        stat = fs.statSync(filePath);
      } catch {
        this.logger?.skip('락 획득 후 파일 사라짐', { project });
        return;
      }

      if (!forceReprocess && !this.state.shouldProcess(filePath, stat.mtimeMs)) {
        if (manual && !batch) {
          vscode.window.showInformationMessage('SecondBrain: 최근에 이미 처리되었습니다.');
        } else {
          this.logger?.skip('변경 없음 (락 후 재확인)', { project });
        }
        return;
      }

      this.statusBar.setProcessing();

      try {
        const session = this.parser.parse(filePath);
        if (!session) {
          this.statusBar.setIdle();
          if (manual && !batch) {
            vscode.window.showWarningMessage('SecondBrain: 대화 파일을 파싱할 수 없습니다.');
          } else {
            this.logger?.skip('JSONL 파싱 실패', { project });
          }
          return;
        }

        // UUID-based incremental slicing (falls back to count-based if UUID not found)
        let newMessages: ParsedMessage[];
        const lastUuid = this.state.getLastProcessedUuid(filePath);
        if (lastUuid) {
          const lastIdx = session.messages.findIndex(m => m.uuid === lastUuid);
          if (lastIdx >= 0) {
            newMessages = session.messages.slice(lastIdx + 1);
          } else {
            // UUID not found — possible /compact rewrite; fall back to count
            this.logger?.warn('마지막 처리 UUID 없음, count 기반 폴백', { project });
            newMessages = session.messages.slice(this.state.getProcessedMessageCount(filePath));
          }
        } else {
          newMessages = session.messages.slice(this.state.getProcessedMessageCount(filePath));
        }

        if (newMessages.length < this.config.minMessages) {
          // Mark as skipped so next batch run won't re-parse unchanged file
          await this.state.markSkipped(filePath, stat.mtimeMs);
          this.statusBar.setIdle();
          if (manual && !batch) {
            vscode.window.showInformationMessage(
              `SecondBrain: 메시지가 너무 적습니다 (${newMessages.length}개, 최소 ${this.config.minMessages}개 필요).`
            );
          } else {
            this.logger?.skip('메시지 부족', { project, 새메시지: newMessages.length, 최소: this.config.minMessages });
          }
          return;
        }

        const provider = this.config.summaryProvider;
        let apiKey: string | undefined;
        if (provider === 'gemini') {
          apiKey = await this.apiKeyManager.get();
          if (!apiKey) {
            this.logger?.warn('API 키 미설정으로 처리 중단', { project });
            if (manual) {
              vscode.window.showWarningMessage(
                'SecondBrain: Gemini API key not set. Run "SecondBrain: Set Gemini API Key".'
              );
            }
            this.statusBar.setIdle();
            return;
          }
        }

        this.logger?.info('처리 시작', { project, 파일: path.basename(filePath), 새메시지: newMessages.length });

        // Gather context: sibling pending sessions + previous notes from this file
        const siblingPending = this.state.getPendingSiblingContext(filePath);
        const previousNoteContext = loadPreviousContext(this.state.getPreviousNoteFiles(filePath));
        const previousContext = [siblingPending, previousNoteContext].filter(Boolean).join('\n\n---\n\n') || undefined;

        // Consume sibling pending contexts before processing
        await this.state.clearSiblingPendingContext(filePath);

        const conversationText = newMessages
          .map((m, i) => `[${this.state.getProcessedMessageCount(filePath) + i}] ${m.role === 'user' ? 'User' : 'Claude'}: ${m.content}`)
          .join('\n\n');

        const sessionWithNewMessages = {
          ...session,
          messages: newMessages,
          firstTimestamp: newMessages[0]?.timestamp ?? session.firstTimestamp,
        };
        const claudeBinary = this.resolvedBinary ?? this.config.claudeCliBinary;
        const summarizer = provider === 'claude-cli'
          ? new ClaudeCLISummarizer(claudeBinary, this.config.claudeCliModel, this.logger)
          : new GeminiSummarizer(apiKey!, this.config.summaryModel, this.logger);
        const summaries = await summarizer.summarize(sessionWithNewMessages, previousContext, signal);

        const lastMsg = session.messages[session.messages.length - 1];

        if (summaries.length === 0) {
          await this.state.markProcessed(filePath, stat.mtimeMs, session.messages.length, [], lastMsg?.uuid);
          this.statusBar.setIdle();
          this.logger?.info('문서화 대상 없음', { project });
          if (manual && !batch) {
            vscode.window.showInformationMessage('SecondBrain: 문서화할 내용이 없는 대화입니다.');
          }
          return;
        }

        // All topics incomplete = review-only, defer note creation
        const allIncomplete = summaries.every(s => s.incomplete);
        if (allIncomplete) {
          await this.state.markPending(filePath, stat.mtimeMs, conversationText);
          this.statusBar.setIdle();
          this.logger?.info('미완료 토픽만 존재, 다음 세션으로 연기', { project, 토픽수: summaries.length });
          if (manual && !batch) {
            vscode.window.showInformationMessage('SecondBrain: 검토 단계로 판단됨 — 다음 세션과 합쳐서 노트를 생성합니다.');
          }
          return;
        }

        await this.vaultIndex.refresh(this.config.vaultPath);
        const linkMatcher = new LinkMatcher(this.vaultIndex);
        const projectName = resolveProjectName(session, filePath);

        const notePaths: string[] = [];
        for (const summary of summaries.filter(s => !s.incomplete)) {
          const matchedLinks = linkMatcher.match(summary.keyTopics);
          const notePath = this.noteWriter.write({
            vaultPath: this.config.vaultPath,
            targetFolder: this.config.targetFolder,
            projectName,
            session: sessionWithNewMessages,
            summary,
            matchedLinks,
            existingNotePath: undefined,
          });
          notePaths.push(notePath);
        }

        await this.state.markProcessed(filePath, stat.mtimeMs, session.messages.length, notePaths, lastMsg?.uuid);

        if (this.logger) {
          this.logger.stats.filesProcessed++;
          this.logger.stats.notesCreated += notePaths.length;
          this.logger.info('노트 생성 완료', {
            project,
            개수: notePaths.length,
            파일: notePaths.map(p => path.basename(p)).join(', '),
          });
        }

        const firstTitle = summaries.find(s => !s.incomplete)?.title ?? 'Claude 대화';
        this.statusBar.setSuccess(firstTitle);

        const label = notePaths.length > 1
          ? `${notePaths.length}개 주제로 저장됨`
          : `"${firstTitle}" saved to Obsidian`;
        if (batch) {
          void vscode.window.showInformationMessage(`SecondBrain: ${label}`, 'Open Note').then(action => {
            if (action === 'Open Note' && notePaths[0]) {
              const uri = vscode.Uri.file(notePaths[0]);
              void vscode.commands.executeCommand('vscode.open', uri);
            }
          });
        } else {
          const action = await vscode.window.showInformationMessage(`SecondBrain: ${label}`, 'Open Note');
          if (action === 'Open Note' && notePaths[0]) {
            const uri = vscode.Uri.file(notePaths[0]);
            await vscode.commands.executeCommand('vscode.open', uri);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 사용자 취소는 에러가 아님 — 조용히 중단
        if (msg === '취소됨') {
          this.logger?.info('처리 취소됨', { project });
          this.statusBar.setIdle();
          return;
        }
        this.logger?.error('처리 실패', { project, 오류: msg });
        this.statusBar.setError(msg);
        if (manual) {
          vscode.window.showErrorMessage(`SecondBrain error: ${msg}`);
        }
      }
    } finally {
      this.fileLock.release(filePath);
    }
  }

  /**
   * Process all new conversations across ALL projects (global incremental).
   * Only files with content newer than the last processed state are included.
   */
  async processCurrent(): Promise<void> {
    if (!fs.existsSync(CLAUDE_PROJECTS_PATH)) {
      vscode.window.showWarningMessage('SecondBrain: ~/.claude/projects 폴더를 찾을 수 없습니다.');
      return;
    }

    // Collect all candidate files with their mtimes
    const candidates: Array<{ filePath: string; mtime: number }> = [];
    for (const filePath of findJsonlFiles(CLAUDE_PROJECTS_PATH)) {
      if (isSubagentFile(filePath)) continue;
      if (this.isExcludedProject(filePath)) continue;
      try {
        const mtime = fs.statSync(filePath).mtimeMs;
        if (this.state.shouldProcess(filePath, mtime)) {
          candidates.push({ filePath, mtime });
        }
      } catch {
        // file disappeared
      }
    }

    if (candidates.length === 0) {
      vscode.window.showInformationMessage('SecondBrain: 처리할 신규 대화가 없습니다.');
      return;
    }

    // Sort oldest-first so previousContext chains build correctly
    candidates.sort((a, b) => a.mtime - b.mtime);

    this.batchInProgress = true;
    let processed = 0;
    let cancelled = false;

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'SecondBrain: 신규 대화 처리 중',
        cancellable: true,
      }, async (progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => {
          cancelled = true;
          abortController.abort();
        });

        for (const { filePath } of candidates) {
          if (cancelled || token.isCancellationRequested) break;

          this.dirtyFiles.delete(filePath);
          progress.report({
            message: `(${processed + 1}/${candidates.length}) ${path.basename(path.dirname(filePath))}`,
            increment: 100 / candidates.length,
          });

          try {
            await this.processFile(filePath, true, false, true, abortController.signal);
          } catch (e) {
            this.logger?.error('배치 처리 오류', {
              project: projectFromPath(filePath),
              오류: e instanceof Error ? e.message : String(e),
            });
          }

          processed++;
        }
      });
    } finally {
      this.batchInProgress = false;
      // Drain any dirty files that accumulated during the batch
      void this.runScheduled();
    }

    const remaining = candidates.length - processed;
    if (cancelled && remaining > 0) {
      vscode.window.showInformationMessage(
        `SecondBrain: ${processed}개 처리 완료. 나머지 ${remaining}개는 다음 스케줄에 처리됩니다.`
      );
    } else if (processed > 0) {
      vscode.window.showInformationMessage(
        `SecondBrain: ${processed}개 대화 처리 완료.`
      );
      this.logger?.printStats();
    }
  }

  /** Returns true if the file path matches any excludeProjects pattern */
  private isExcludedProject(filePath: string): boolean {
    const excludes = this.config.excludeProjects;
    if (excludes.length === 0) return false;
    const normalized = filePath.replace(/\\/g, '/');
    return excludes.some(pattern => normalized.includes(pattern));
  }

  dispose(): void {
    if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
    this.fileLock.releaseAll();
    this.watcher?.close();
  }
}

/** Returns milliseconds until next :00, :20, or :40 slot */
function msUntilNextSlot(): number {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const ms = now.getMilliseconds();
  let targetMinute: number;
  if (minutes < 20) targetMinute = 20;
  else if (minutes < 40) targetMinute = 40;
  else targetMinute = 60; // next hour :00
  return (targetMinute - minutes) * 60_000 - seconds * 1000 - ms;
}

function resolveProjectName(session: { projectPath: string }, filePath?: string): string {
  const normalize = (p: string) => path.normalize(p).toLowerCase();

  // 1. cwd를 사용할 수 있을 때: workspace 폴더 경로 매칭 후 basename
  if (session.projectPath) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (wsFolder && normalize(session.projectPath).startsWith(normalize(wsFolder.uri.fsPath))) {
      return wsFolder.name;
    }
    const fromCwd = path.basename(session.projectPath);
    if (fromCwd) return fromCwd;
  }

  // 2. cwd가 없을 때(Windows 버그 등): 인코딩된 JSONL 폴더명을 workspace 폴더와 직접 비교
  if (filePath) {
    const encodedFolder = projectFromPath(filePath);
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of wsFolders) {
      if (encodePathForClaude(folder.uri.fsPath).toLowerCase() === encodedFolder.toLowerCase()) {
        return folder.name;
      }
    }
    // 최후 fallback: 인코딩 폴더명 전체를 식별자로 사용 (앞의 - 제거)
    // 하이픈이 포함된 프로젝트명 분리 불가 문제를 피하고, 프로젝트 간 충돌 방지
    const fallback = encodedFolder.replace(/^-+/, '');
    if (fallback) return fallback;
  }

  return 'unknown-project';
}

/**
 * Load previous note context using only Summary, Decisions, and Insights sections.
 * Applies a 2KB cap to prevent token bloat.
 */
function loadPreviousContext(noteFiles: string[]): string | undefined {
  const contents: string[] = [];
  for (const filePath of noteFiles) {
    try {
      contents.push(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      // File may have been deleted — skip
    }
  }
  if (contents.length === 0) return undefined;
  const result = buildPreviousContextSection(contents);
  return result || undefined;
}

function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}
