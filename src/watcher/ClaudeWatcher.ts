import * as chokidar from 'chokidar';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { JsonlParser } from '../parser/JsonlParser';
import { ProcessedState } from '../state/ProcessedState';
import { GeminiSummarizer } from '../summarizer/GeminiSummarizer';
import { VaultIndex } from '../vault/VaultIndex';
import { LinkMatcher } from '../vault/LinkMatcher';
import { NoteWriter } from '../vault/NoteWriter';
import { FileLock } from '../state/FileLock';
import type { Config, ApiKeyManager } from '../config';
import type { StatusBar } from '../ui/StatusBar';

const CLAUDE_PROJECTS_PATH = path.join(os.homedir(), '.claude', 'projects');
const SUBAGENTS_PATH_SEGMENT = '/subagents/';

function isSubagentFile(filePath: string): boolean {
  return filePath.includes(SUBAGENTS_PATH_SEGMENT);
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

  constructor(
    private config: Config,
    private apiKeyManager: ApiKeyManager,
    private statusBar: StatusBar
  ) {
    this.state = new ProcessedState();
  }

  start(): void {
    const watchPath = CLAUDE_PROJECTS_PATH;
    if (!fs.existsSync(watchPath)) return;

    // Pre-seed state with all existing files so fresh installs don't bulk-process history
    this.initializeExistingFiles(watchPath).catch(() => {});

    // chokidar glob requires forward slashes even on Windows
    const globPattern = watchPath.replace(/\\/g, '/') + '/**/*.jsonl';

    this.watcher = chokidar.watch(globPattern, {
      ignoreInitial: true,
      ignored: '**/subagents/**',
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      persistent: true,
    });

    this.watcher.on('add', (filePath) => this.onFileAdd(filePath));
    this.watcher.on('change', (filePath) => this.onFileChange(filePath));

    this.startScheduler();
  }

  private async initializeExistingFiles(watchPath: string): Promise<void> {
    const toSeed: Array<{ filePath: string; mtime: number; messageCount: number }> = [];
    const toProcess: string[] = [];
    for (const filePath of findJsonlFiles(watchPath).filter(f => !isSubagentFile(f))) {
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
    await this.state.seedFiles(toSeed);
    for (const filePath of toProcess) {
      this.dirtyFiles.add(filePath);
    }
  }

  private onFileAdd(newFilePath: string): void {
    if (!this.config.enabled) return;

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
    this.dirtyFiles.add(filePath);
  }

  private startScheduler(): void {
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
    const files = Array.from(this.dirtyFiles);
    this.dirtyFiles.clear();
    for (const filePath of files) {
      await this.processFile(filePath);
    }
  }

  async processFile(filePath: string, manual = false, forceReprocess = false): Promise<void> {
    if (this.inFlight.has(filePath)) {
      if (manual) {
        vscode.window.showInformationMessage('SecondBrain: 이미 처리 중입니다.');
      }
      return;
    }
    if (!this.config.isValid()) {
      if (manual) {
        vscode.window.showWarningMessage('SecondBrain: Vault 경로가 설정되지 않았습니다. Setup 명령을 실행하세요.');
      }
      return;
    }

    this.inFlight.add(filePath);
    try {
      await this._processFile(filePath, manual, forceReprocess);
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  private async _processFile(filePath: string, manual = false, forceReprocess = false): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      if (manual) {
        vscode.window.showWarningMessage('SecondBrain: 대화 파일을 읽을 수 없습니다.');
      }
      return;
    }

    if (!forceReprocess && !this.state.shouldProcess(filePath, stat.mtimeMs)) {
      if (manual) {
        vscode.window.showInformationMessage('SecondBrain: 변경된 내용이 없습니다.');
      }
      return;
    }

    if (!(await this.fileLock.acquire(filePath))) {
      if (manual) {
        vscode.window.showInformationMessage('SecondBrain: 다른 창에서 처리 중입니다.');
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
            if (manual) {
              vscode.window.showInformationMessage('SecondBrain: 최근에 이미 처리되었습니다.');
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
        return;
      }

      if (!forceReprocess && !this.state.shouldProcess(filePath, stat.mtimeMs)) {
        if (manual) {
          vscode.window.showInformationMessage('SecondBrain: 최근에 이미 처리되었습니다.');
        }
        return;
      }

      this.statusBar.setProcessing();

      try {
        const session = this.parser.parse(filePath);
        if (!session) {
          this.statusBar.setIdle();
          if (manual) {
            vscode.window.showWarningMessage('SecondBrain: 대화 파일을 파싱할 수 없습니다.');
          }
          return;
        }

        const alreadyProcessed = this.state.getProcessedMessageCount(filePath);
        const newMessages = session.messages.slice(alreadyProcessed);

        if (newMessages.length < this.config.minMessages) {
          this.statusBar.setIdle();
          if (manual) {
            vscode.window.showInformationMessage(
              `SecondBrain: 메시지가 너무 적습니다 (${newMessages.length}개, 최소 ${this.config.minMessages}개 필요).`
            );
          }
          return;
        }

        const apiKey = await this.apiKeyManager.get();
        if (!apiKey) {
          vscode.window.showWarningMessage(
            'SecondBrain: Gemini API key not set. Run "SecondBrain: Set Gemini API Key".'
          );
          this.statusBar.setIdle();
          return;
        }

        // Gather context: sibling pending sessions + previous notes from this file
        const siblingPending = this.state.getPendingSiblingContext(filePath);
        const previousNoteContext = loadPreviousContext(this.state.getPreviousNoteFiles(filePath));
        const previousContext = [siblingPending, previousNoteContext].filter(Boolean).join('\n\n---\n\n') || undefined;

        // Consume sibling pending contexts before processing
        await this.state.clearSiblingPendingContext(filePath);

        const conversationText = newMessages
          .map((m, i) => `[${alreadyProcessed + i}] ${m.role === 'user' ? 'User' : 'Claude'}: ${m.content}`)
          .join('\n\n');

        const sessionWithNewMessages = {
          ...session,
          messages: newMessages,
          firstTimestamp: newMessages[0]?.timestamp ?? session.firstTimestamp,
        };
        const summarizer = new GeminiSummarizer(apiKey, this.config.summaryModel);
        const summaries = await summarizer.summarize(sessionWithNewMessages, previousContext);

        if (summaries.length === 0) {
          await this.state.markProcessed(filePath, stat.mtimeMs, session.messages.length, []);
          this.statusBar.setIdle();
          if (manual) {
            vscode.window.showInformationMessage('SecondBrain: 문서화할 내용이 없는 대화입니다.');
          }
          return;
        }

        // All topics incomplete = review-only, defer note creation
        const allIncomplete = summaries.every(s => s.incomplete);
        if (allIncomplete) {
          await this.state.markPending(filePath, stat.mtimeMs, conversationText);
          this.statusBar.setIdle();
          if (manual) {
            vscode.window.showInformationMessage('SecondBrain: 검토 단계로 판단됨 — 다음 세션과 합쳐서 노트를 생성합니다.');
          }
          return;
        }

        await this.vaultIndex.refresh(this.config.vaultPath);
        const linkMatcher = new LinkMatcher(this.vaultIndex);
        const projectName = resolveProjectName(session);

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

        await this.state.markProcessed(filePath, stat.mtimeMs, session.messages.length, notePaths);

        const firstTitle = summaries.find(s => !s.incomplete)?.title ?? 'Claude 대화';
        this.statusBar.setSuccess(firstTitle);

        const label = notePaths.length > 1
          ? `${notePaths.length}개 주제로 저장됨`
          : `"${firstTitle}" saved to Obsidian`;
        const action = await vscode.window.showInformationMessage(
          `SecondBrain: ${label}`,
          'Open Note'
        );
        if (action === 'Open Note') {
          const uri = vscode.Uri.file(notePaths[0]);
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.statusBar.setError(msg);
        vscode.window.showErrorMessage(`SecondBrain error: ${msg}`);
      }
    } finally {
      this.fileLock.release(filePath);
    }
  }

  /** Process only the most recently modified JSONL file (current session) */
  async processCurrent(): Promise<void> {
    if (!fs.existsSync(CLAUDE_PROJECTS_PATH)) {
      vscode.window.showWarningMessage('SecondBrain: ~/.claude/projects 폴더를 찾을 수 없습니다.');
      return;
    }

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    let searchDir = CLAUDE_PROJECTS_PATH;
    if (wsFolder) {
      const encoded = wsFolder.uri.fsPath.replace(/\//g, '-');
      searchDir = path.join(CLAUDE_PROJECTS_PATH, encoded);
    }

    const files = findJsonlFiles(searchDir).filter(f => !isSubagentFile(f));
    if (files.length === 0) {
      vscode.window.showWarningMessage('SecondBrain: 대화 파일(.jsonl)이 없습니다.');
      return;
    }

    let latest = files[0];
    let latestMtime = fs.statSync(latest).mtimeMs;
    for (let i = 1; i < files.length; i++) {
      const mtime = fs.statSync(files[i]).mtimeMs;
      if (mtime > latestMtime) { latest = files[i]; latestMtime = mtime; }
    }

    // Remove from dirty set so scheduler doesn't double-process
    this.dirtyFiles.delete(latest);

    vscode.window.showInformationMessage(
      `SecondBrain: 처리 시작 — ${path.basename(path.dirname(latest))}`
    );

    await this.processFile(latest, true, true);
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

function resolveProjectName(session: { projectPath: string }): string {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (wsFolder) {
    const wsPath = wsFolder.uri.fsPath;
    const normalize = (p: string) => path.normalize(p).toLowerCase();
    if (normalize(session.projectPath).startsWith(normalize(wsPath))) {
      return wsFolder.name;
    }
  }

  return path.basename(session.projectPath) || 'unknown-project';
}

function loadPreviousContext(noteFiles: string[]): string | undefined {
  const parts: string[] = [];
  for (const filePath of noteFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Strip ## Full Conversation section and everything after it
      const stripped = content.replace(/^## Full Conversation[\s\S]*/m, '').trim();
      if (stripped) parts.push(stripped);
    } catch {
      // File may have been deleted — skip
    }
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
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
