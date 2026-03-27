import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const LOCKS_DIR = path.join(os.homedir(), '.vsc-secondbrain', 'locks');
const STALE_THRESHOLD_MS = 120_000;
const RETRY_INTERVAL_MS = 200;

interface LockMeta {
  pid: number;
  timestamp: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class FileLock {
  private heldLocks = new Set<string>();

  constructor() {
    fs.mkdirSync(LOCKS_DIR, { recursive: true });
  }

  async acquire(filePath: string, timeoutMs = 30_000): Promise<boolean> {
    const lockDir = this.lockDirFor(filePath);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        fs.mkdirSync(lockDir, { recursive: false });
        this.writeMeta(lockDir);
        this.heldLocks.add(lockDir);
        return true;
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;

        if (this.isStale(lockDir)) {
          fs.rmSync(lockDir, { recursive: true, force: true });
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
    const lockDir = this.lockDirFor(filePath);
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Already removed
    }
    this.heldLocks.delete(lockDir);
  }

  releaseAll(): void {
    for (const lockDir of this.heldLocks) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {}
    }
    this.heldLocks.clear();
  }

  private lockDirFor(filePath: string): string {
    const hash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    return path.join(LOCKS_DIR, `${hash}.lock`);
  }

  private writeMeta(lockDir: string): void {
    const meta: LockMeta = { pid: process.pid, timestamp: Date.now() };
    fs.writeFileSync(path.join(lockDir, 'meta.json'), JSON.stringify(meta), 'utf-8');
  }

  private isStale(lockDir: string): boolean {
    try {
      const raw = fs.readFileSync(path.join(lockDir, 'meta.json'), 'utf-8');
      const meta: LockMeta = JSON.parse(raw);

      if (Date.now() - meta.timestamp > STALE_THRESHOLD_MS) return true;

      try {
        process.kill(meta.pid, 0);
        return false;
      } catch {
        return true;
      }
    } catch {
      return true;
    }
  }
}
