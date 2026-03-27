import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface StateEntry {
  mtime: number;
  processedMessageCount: number;
  noteFiles: string[];
  processedAt: string;
}

interface StateData {
  version: 1;
  entries: Record<string, StateEntry>; // key = filePath
}

export class ProcessedState {
  private stateDir: string;
  private stateFile: string;
  private data: StateData;

  constructor() {
    this.stateDir = path.join(os.homedir(), '.vsc-secondbrain');
    this.stateFile = path.join(this.stateDir, 'state.json');
    this.data = this.load();
  }

  private load(): StateData {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const raw = fs.readFileSync(this.stateFile, 'utf-8');
      return JSON.parse(raw) as StateData;
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private save(): void {
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.stateFile);
  }

  shouldProcess(filePath: string, mtime: number): boolean {
    const entry = this.data.entries[filePath];
    if (!entry) return true;
    return mtime > entry.mtime;
  }

  /** Returns number of messages already processed for this session (0 if new) */
  getProcessedMessageCount(filePath: string): number {
    return this.data.entries[filePath]?.processedMessageCount ?? 0;
  }

  /** Returns note file paths created during previous processing */
  getPreviousNoteFiles(filePath: string): string[] {
    return this.data.entries[filePath]?.noteFiles ?? [];
  }

  markProcessed(filePath: string, mtime: number, messageCount: number, noteFiles: string[]): void {
    this.data.entries[filePath] = {
      mtime,
      processedMessageCount: messageCount,
      noteFiles,
      processedAt: new Date().toISOString(),
    };
    this.save();
  }

  clearAll(): void {
    this.data = { version: 1, entries: {} };
    this.save();
  }

  getAllEntries(): Record<string, StateEntry> {
    return { ...this.data.entries };
  }
}
