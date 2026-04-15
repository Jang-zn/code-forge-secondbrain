import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileLock } from './FileLock';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const LOCKS_DIR = path.join(os.homedir(), '.vsc-secondbrain', 'locks');

function lockFileFor(filePath: string): string {
  const hash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  return path.join(LOCKS_DIR, `${hash}.lock`);
}

function makePath(name: string): string {
  return `/tmp/vsc-secondbrain-test-${process.pid}-${name}`;
}

afterEach(() => {
  // 테스트 후 생성된 락 파일 정리
  try {
    const files = fs.readdirSync(LOCKS_DIR);
    for (const f of files) {
      if (f.endsWith('.lock')) {
        try { fs.unlinkSync(path.join(LOCKS_DIR, f)); } catch {}
      }
    }
  } catch {}
});

describe('FileLock', () => {
  it('acquire() + release(): 락 획득 후 해제', async () => {
    const lock = new FileLock();
    const p = makePath('basic');

    const acquired = await lock.acquire(p, 1000);
    expect(acquired).toBe(true);

    expect(() => lock.release(p)).not.toThrow();
  });

  it('동일 경로 이중 acquire: 두 번째는 false 반환', async () => {
    const lock1 = new FileLock();
    const lock2 = new FileLock();
    const p = makePath('double');

    const first = await lock1.acquire(p, 1000);
    expect(first).toBe(true);

    // 짧은 타임아웃으로 빠르게 실패하게
    const second = await lock2.acquire(p, 100);
    expect(second).toBe(false);

    lock1.release(p);
  });

  it('release 후 재획득: 성공', async () => {
    const lock1 = new FileLock();
    const lock2 = new FileLock();
    const p = makePath('reacquire');

    await lock1.acquire(p, 1000);
    lock1.release(p);

    const reacquired = await lock2.acquire(p, 1000);
    expect(reacquired).toBe(true);
    lock2.release(p);
  });

  it('releaseAll(): 보유 중인 모든 락 해제', async () => {
    const lock = new FileLock();
    const p1 = makePath('all-1');
    const p2 = makePath('all-2');

    await lock.acquire(p1, 1000);
    await lock.acquire(p2, 1000);

    expect(() => lock.releaseAll()).not.toThrow();

    // releaseAll 후에는 다른 인스턴스가 재획득 가능해야 함
    const lock2 = new FileLock();
    const a = await lock2.acquire(p1, 500);
    const b = await lock2.acquire(p2, 500);
    expect(a).toBe(true);
    expect(b).toBe(true);
    lock2.releaseAll();
  });

  it('stale 락 감지: 오래된 타임스탬프 + 죽은 PID → acquire 성공', async () => {
    const lock1 = new FileLock();
    const p = makePath('stale');

    // 먼저 획득해서 락 파일 경로를 만들어 둠
    await lock1.acquire(p, 1000);
    const lockFile = lockFileFor(p);

    // 타임스탬프를 360_001ms 이전으로, PID를 존재할 수 없는 값으로 덮어씀
    const staleMeta = { pid: 99999999, timestamp: Date.now() - 360_001 };
    fs.writeFileSync(lockFile, JSON.stringify(staleMeta), 'utf-8');
    // heldLocks에서 제거하기 위해 release 호출 (파일은 이미 덮어씀)
    // lock1 내부 heldLocks 정리만 목적 — 파일은 stale 상태로 남아 있음
    lock1['heldLocks'].delete(lockFile);

    // 새 인스턴스가 stale 락을 탐지하고 획득해야 함
    const lock2 = new FileLock();
    const acquired = await lock2.acquire(p, 1000);
    expect(acquired).toBe(true);

    lock2.release(p);
  });

  it('concurrent acquire race: 두 인스턴스 중 정확히 하나만 성공', async () => {
    const lock1 = new FileLock();
    const lock2 = new FileLock();
    const p = makePath('race');

    const [r1, r2] = await Promise.all([
      lock1.acquire(p, 200),
      lock2.acquire(p, 200),
    ]);

    // 정확히 하나만 true여야 함
    expect(r1 || r2).toBe(true);
    expect(r1 && r2).toBe(false);

    lock1.releaseAll();
    lock2.releaseAll();
  });
});
