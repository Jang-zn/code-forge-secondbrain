import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const DEFAULT_LOCKS_DIR = path.join(os.homedir(), '.vsc-secondbrain', 'locks');
const STALE_THRESHOLD_MS = 360_000;
const RETRY_INTERVAL_MS = 200;
const GRACE_PERIOD_MS = 5_000;

interface LockMeta {
  pid: number;
  timestamp: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class FileLock {
  private heldLocks = new Set<string>();
  private locksDir: string;

  constructor(locksDir?: string) {
    this.locksDir = locksDir ?? DEFAULT_LOCKS_DIR;
    fs.mkdirSync(this.locksDir, { recursive: true });
  }

  async acquire(filePath: string, timeoutMs = 30_000): Promise<boolean> {
    const lockFile = this.lockFileFor(filePath);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const meta: LockMeta = { pid: process.pid, timestamp: Date.now() };
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeFileSync(fd, JSON.stringify(meta), 'utf-8');
        fs.closeSync(fd);
        this.heldLocks.add(lockFile);
        return true;
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;

        if (this.isStale(lockFile)) {
          try { fs.unlinkSync(lockFile); } catch {}
          continue;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(RETRY_INTERVAL_MS, remaining));
      }
    }

    return false;
  }

  release(filePath: string): void {
    const lockFile = this.lockFileFor(filePath);
    try { fs.unlinkSync(lockFile); } catch {}
    this.heldLocks.delete(lockFile);
  }

  releaseAll(): void {
    for (const lockFile of this.heldLocks) {
      try { fs.unlinkSync(lockFile); } catch {}
    }
    this.heldLocks.clear();
  }

  private lockFileFor(filePath: string): string {
    const hash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    return path.join(this.locksDir, `${hash}.lock`);
  }

  private isStale(lockFile: string): boolean {
    try {
      const raw = fs.readFileSync(lockFile, 'utf-8');
      if (!raw.trim()) {
        try {
          return (Date.now() - fs.statSync(lockFile).ctimeMs) > GRACE_PERIOD_MS;
        } catch {
          return true;
        }
      }
      return this.isMetaStale(JSON.parse(raw));
    } catch {
      return true;
    }
  }

  private isMetaStale(meta: LockMeta): boolean {
    if (Date.now() - meta.timestamp > STALE_THRESHOLD_MS) return true;
    try { process.kill(meta.pid, 0); return false; } catch { return true; }
  }
}
