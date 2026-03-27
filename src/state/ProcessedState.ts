import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileLock } from './FileLock';

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

const STATE_LOCK_KEY = path.join(os.homedir(), '.vsc-secondbrain', '__state_lock__');

export class ProcessedState {
  private stateDir: string;
  private stateFile: string;
  private data: StateData;
  private stateLock = new FileLock();

  constructor() {
    this.stateDir = path.join(os.homedir(), '.vsc-secondbrain');
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.stateFile = path.join(this.stateDir, 'state.json');
    this.data = this.load();
  }

  private load(): StateData {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf-8');
      return JSON.parse(raw) as StateData;
    } catch {
      return { version: 1, entries: {} };
    }
  }

  /** Re-read state.json from disk to pick up writes from other instances */
  reload(): void {
    this.data = this.load();
  }

  private save(): void {
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.stateFile);
  }

  private async withStateLock(mutate: (data: StateData) => void): Promise<void> {
    const locked = await this.stateLock.acquire(STATE_LOCK_KEY, 5_000);
    if (!locked) return; // Skip write rather than race without lock
    try {
      const fresh = this.load();
      mutate(fresh);
      this.data = fresh;
      this.save();
    } finally {
      this.stateLock.release(STATE_LOCK_KEY);
    }
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

  async markProcessed(filePath: string, mtime: number, messageCount: number, noteFiles: string[]): Promise<void> {
    await this.withStateLock(data => {
      data.entries[filePath] = {
        mtime,
        processedMessageCount: messageCount,
        noteFiles,
        processedAt: new Date().toISOString(),
      };
    });
  }

  /** Seed multiple files at once with a single disk write (used at startup) */
  async seedFiles(entries: Array<{ filePath: string; mtime: number; messageCount: number }>): Promise<void> {
    if (entries.length === 0) return;
    await this.withStateLock(data => {
      for (const { filePath, mtime, messageCount } of entries) {
        data.entries[filePath] = {
          mtime,
          processedMessageCount: messageCount,
          noteFiles: [],
          processedAt: new Date().toISOString(),
        };
      }
    });
  }

  async resetEntry(filePath: string): Promise<void> {
    await this.withStateLock(data => {
      const entry = data.entries[filePath];
      if (entry) {
        entry.mtime = 0;
        entry.processedMessageCount = 0;
      }
    });
  }

  async clearAll(): Promise<void> {
    await this.withStateLock(data => {
      data.entries = {};
    });
  }

  getAllEntries(): Record<string, StateEntry> {
    return { ...this.data.entries };
  }
}
