import * as chokidar from 'chokidar';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { DebounceQueue } from './DebounceQueue';
import { JsonlParser } from '../parser/JsonlParser';
import { ProcessedState } from '../state/ProcessedState';
import { GeminiSummarizer } from '../summarizer/GeminiSummarizer';
import { VaultIndex } from '../vault/VaultIndex';
import { LinkMatcher } from '../vault/LinkMatcher';
import { NoteWriter } from '../vault/NoteWriter';
import type { Config, ApiKeyManager } from '../config';
import type { StatusBar } from '../ui/StatusBar';

export class ClaudeWatcher implements vscode.Disposable {
  private watcher: chokidar.FSWatcher | null = null;
  private debounceQueue: DebounceQueue;
  private parser = new JsonlParser();
  private state: ProcessedState;
  private vaultIndex = new VaultIndex();
  private noteWriter = new NoteWriter();

  constructor(
    private config: Config,
    private apiKeyManager: ApiKeyManager,
    private statusBar: StatusBar
  ) {
    this.state = new ProcessedState();
    this.debounceQueue = new DebounceQueue(config.debounceSeconds * 1000);
  }

  start(): void {
    const watchPath = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(watchPath)) return;

    // chokidar glob requires forward slashes even on Windows
    const globPattern = watchPath.replace(/\\/g, '/') + '/**/*.jsonl';

    this.watcher = chokidar.watch(globPattern, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      persistent: true,
    });

    this.watcher.on('add', (filePath) => this.onFileChange(filePath));
    this.watcher.on('change', (filePath) => this.onFileChange(filePath));
  }

  private onFileChange(filePath: string): void {
    if (!this.config.enabled) return;

    this.debounceQueue.enqueue(filePath, async () => {
      await this.processFile(filePath);
    });
  }

  async processFile(filePath: string): Promise<void> {
    if (!this.config.isValid()) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    if (!this.state.shouldProcess(filePath, stat.mtimeMs)) return;

    this.statusBar.setProcessing();

    try {
      const session = this.parser.parse(filePath);
      if (!session) {
        this.statusBar.setIdle();
        return;
      }

      // Guard: minimum messages
      if (session.messages.length < this.config.minMessages) {
        this.statusBar.setIdle();
        return;
      }

      // Get API key
      const apiKey = await this.apiKeyManager.get();
      if (!apiKey) {
        vscode.window.showWarningMessage(
          'SecondBrain: Gemini API key not set. Run "SecondBrain: Set Gemini API Key".'
        );
        this.statusBar.setIdle();
        return;
      }

      // Summarize (returns array of topic summaries)
      const summarizer = new GeminiSummarizer(apiKey, this.config.summaryModel);
      const summaries = await summarizer.summarize(session);

      // Match vault links and write one note per topic
      await this.vaultIndex.refresh(this.config.vaultPath);
      const linkMatcher = new LinkMatcher(this.vaultIndex);
      const projectName = resolveProjectName(session);

      const notePaths: string[] = [];
      for (const summary of summaries) {
        const matchedLinks = linkMatcher.match(summary.keyTopics);
        const notePath = this.noteWriter.write({
          vaultPath: this.config.vaultPath,
          targetFolder: this.config.targetFolder,
          projectName,
          session,
          summary,
          matchedLinks,
          existingNotePath: undefined,
        });
        notePaths.push(notePath);
      }

      // Mark as processed
      this.state.markProcessed(filePath, stat.mtimeMs, notePaths[0] ?? '');

      const firstTitle = summaries[0]?.title ?? 'Claude 대화';
      this.statusBar.setSuccess(firstTitle);

      // Show notification with "Open Note" button
      const label = summaries.length > 1
        ? `${summaries.length}개 주제로 저장됨`
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
  }

  async processAll(): Promise<void> {
    const watchPath = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(watchPath)) return;

    const files = findJsonlFiles(watchPath);
    vscode.window.showInformationMessage(
      `SecondBrain: Processing ${files.length} conversation files…`
    );

    for (const file of files) {
      // Override shouldProcess check for processAll
      const stat = fs.statSync(file);
      this.state['data'] && delete (this.state as any)['data']['entries'][file];
      await this.processFile(file);
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.debounceQueue.dispose();
  }
}

function resolveProjectName(session: { projectPath: string }): string {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (wsFolder) {
    const wsPath = wsFolder.uri.fsPath;
    // Case-insensitive comparison for Windows (C:\Users vs c:\users)
    const normalize = (p: string) => path.normalize(p).toLowerCase();
    if (normalize(session.projectPath).startsWith(normalize(wsPath))) {
      return wsFolder.name;
    }
  }

  return path.basename(session.projectPath) || 'unknown-project';
}

function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = require('path').join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}
