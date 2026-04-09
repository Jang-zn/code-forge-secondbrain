import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileLock } from './FileLock';

interface StateEntry {
  mtime: number;
  processedMessageCount: number;
  lastProcessedUuid?: string;
  noteFiles: string[];
  processedAt: string;
  pendingContext?: string;
  pendingAt?: string;
  skipped?: boolean;
}

interface StateData {
  version: 1;
  entries: Record<string, StateEntry>;
  lastGcAt?: string;
}

const STATE_LOCK_KEY = path.join(os.homedir(), '.vsc-secondbrain', '__state_lock__');
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

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
      const data = JSON.parse(raw) as StateData;
      // Migrate old noteFile (string) → noteFiles (array) format
      for (const entry of Object.values(data.entries)) {
        const legacy = entry as any;
        if (!Array.isArray(entry.noteFiles) && typeof legacy.noteFile === 'string') {
          entry.noteFiles = [legacy.noteFile];
          delete legacy.noteFile;
        }
        entry.noteFiles ??= [];
        entry.processedMessageCount ??= 0;
      }
      return data;
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

  /** Acquire state lock with up to 3 retries; warns if all fail instead of silently dropping */
  private async withStateLock(mutate: (data: StateData) => void, context?: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const locked = await this.stateLock.acquire(STATE_LOCK_KEY, 5_000);
      if (locked) {
        try {
          const fresh = this.load();
          mutate(fresh);
          this.data = fresh;
          this.save();
        } finally {
          this.stateLock.release(STATE_LOCK_KEY);
        }
        return;
      }
    }
    console.warn(`[SecondBrain] 상태 락 획득 실패 (3회 시도), 쓰기 건너뜀${context ? ': ' + context : ''}`);
  }

  hasEntry(filePath: string): boolean {
    return filePath in this.data.entries;
  }

  shouldProcess(filePath: string, mtime: number): boolean {
    const entry = this.data.entries[filePath];
    if (!entry) return true;
    // skipped entries: only re-process if mtime has advanced (file has more content)
    return mtime > entry.mtime;
  }

  /** Returns number of messages already processed for this session (0 if new) */
  getProcessedMessageCount(filePath: string): number {
    return this.data.entries[filePath]?.processedMessageCount ?? 0;
  }

  /** Returns the uuid of the last processed message, for content-stable incremental slicing */
  getLastProcessedUuid(filePath: string): string | undefined {
    return this.data.entries[filePath]?.lastProcessedUuid;
  }

  /** Returns note file paths created during previous processing */
  getPreviousNoteFiles(filePath: string): string[] {
    return this.data.entries[filePath]?.noteFiles ?? [];
  }

  async markProcessed(
    filePath: string,
    mtime: number,
    messageCount: number,
    noteFiles: string[],
    lastUuid?: string,
  ): Promise<void> {
    await this.withStateLock(data => {
      const existing = data.entries[filePath];
      const previousNotes = existing?.noteFiles ?? [];
      const merged = [...new Set([...previousNotes, ...noteFiles])];
      data.entries[filePath] = {
        mtime,
        processedMessageCount: messageCount,
        lastProcessedUuid: lastUuid,
        noteFiles: merged,
        processedAt: new Date().toISOString(),
      };
    }, filePath);
  }

  /**
   * Mark file as skipped (message count below minimum).
   * Records the current mtime so repeated batch runs don't re-parse unchanged files.
   * Does NOT overwrite an already fully-processed entry.
   */
  async markSkipped(filePath: string, mtime: number): Promise<void> {
    await this.withStateLock(data => {
      const existing = data.entries[filePath];
      if (!existing || mtime > existing.mtime) {
        data.entries[filePath] = {
          mtime,
          processedMessageCount: existing?.processedMessageCount ?? 0,
          noteFiles: existing?.noteFiles ?? [],
          processedAt: new Date().toISOString(),
          skipped: true,
        };
      }
    }, filePath);
  }

  /** Seed multiple files at once with a single disk write (used at startup) */
  async seedFiles(entries: Array<{ filePath: string; mtime: number; messageCount: number }>): Promise<void> {
    if (entries.length === 0) return;
    await this.withStateLock(data => {
      for (const { filePath, mtime, messageCount } of entries) {
        // Guard: don't overwrite if a concurrent processFile already wrote this entry
        if (data.entries[filePath]) continue;
        data.entries[filePath] = {
          mtime,
          processedMessageCount: messageCount,
          noteFiles: [],
          processedAt: new Date().toISOString(),
        };
      }
    });
  }

  /** Mark session as incomplete (review-only) — saves context for combining with next session */
  async markPending(filePath: string, mtime: number, pendingContext: string): Promise<void> {
    await this.withStateLock(data => {
      const existing = data.entries[filePath];
      data.entries[filePath] = {
        mtime,
        processedMessageCount: existing?.processedMessageCount ?? 0,
        noteFiles: existing?.noteFiles ?? [],
        processedAt: new Date().toISOString(),
        pendingContext,
        pendingAt: new Date().toISOString(),
      };
    }, filePath);
  }

  /** Returns combined pending context text from sibling sessions in same project directory.
   *  Ignores entries older than 7 days to prevent stale context from polluting new sessions. */
  getPendingSiblingContext(filePath: string): string | undefined {
    const dir = path.dirname(filePath);
    const now = Date.now();
    const parts: string[] = [];
    for (const [entryPath, entry] of Object.entries(this.data.entries)) {
      if (entryPath === filePath) continue;
      if (path.dirname(entryPath) !== dir) continue;
      if (!entry.pendingContext) continue;
      // Skip stale pending contexts (older than 7 days)
      if (entry.pendingAt && now - new Date(entry.pendingAt).getTime() > PENDING_MAX_AGE_MS) continue;
      parts.push(entry.pendingContext);
    }
    return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
  }

  /** Clear pending context for sibling sessions (after consuming them) */
  async clearSiblingPendingContext(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    const siblings = Object.keys(this.data.entries).filter(
      p => p !== filePath && path.dirname(p) === dir && this.data.entries[p]?.pendingContext
    );
    if (siblings.length === 0) return;
    await this.withStateLock(data => {
      for (const sibling of siblings) {
        if (data.entries[sibling]) {
          delete data.entries[sibling].pendingContext;
          delete data.entries[sibling].pendingAt;
        }
      }
    });
  }

  async resetEntry(filePath: string): Promise<void> {
    await this.withStateLock(data => {
      const entry = data.entries[filePath];
      if (entry) {
        entry.mtime = 0;
        entry.processedMessageCount = 0;
        entry.lastProcessedUuid = undefined;
        entry.noteFiles = [];
        delete entry.skipped;
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

  /** Returns true if GC should run (hasn't run in the last 24 hours) */
  needsGc(): boolean {
    if (!this.data.lastGcAt) return true;
    return Date.now() - new Date(this.data.lastGcAt).getTime() >= GC_INTERVAL_MS;
  }

  /** GC: remove state entries for .jsonl files that no longer exist on disk.
   *  Safe to call at most once per day (gated by needsGc()). */
  async gcStaleEntries(): Promise<void> {
    const now = new Date().toISOString();
    const toRemove: string[] = [];
    for (const filePath of Object.keys(this.data.entries)) {
      try {
        fs.accessSync(filePath);
      } catch {
        toRemove.push(filePath);
      }
    }

    await this.withStateLock(data => {
      for (const filePath of toRemove) {
        delete data.entries[filePath];
      }
      data.lastGcAt = now;
    }, 'gc');
  }
}
