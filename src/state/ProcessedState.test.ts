import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// vi.mock은 호이스팅되므로 리터럴 경로를 직접 사용
const TEST_HOME = `/tmp/vsc-secondbrain-test-${process.pid}`;

vi.mock('os', () => ({
  homedir: () => `/tmp/vsc-secondbrain-test-${process.pid}`,
  tmpdir: () => '/tmp',
  platform: () => process.platform,
}));

// mock 설정 후 ProcessedState import
const { ProcessedState } = await import('./ProcessedState');

beforeAll(() => {
  fs.mkdirSync(path.join(TEST_HOME, '.vsc-secondbrain', 'locks'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  // 각 테스트 전 state.json 삭제하여 깨끗한 상태로 시작
  const stateFile = path.join(TEST_HOME, '.vsc-secondbrain', 'state.json');
  try { fs.unlinkSync(stateFile); } catch {}
  // tmp lock file도 정리
  const locksDir = path.join(TEST_HOME, '.vsc-secondbrain', 'locks');
  try {
    const files = fs.readdirSync(locksDir);
    for (const f of files) { try { fs.unlinkSync(path.join(locksDir, f)); } catch {} }
  } catch {}
});

function makeFilePath(name: string): string {
  return `/fake/project/${name}.jsonl`;
}

describe('ProcessedState', () => {
  it('hasEntry: 새 경로는 false, markProcessed 후는 true', async () => {
    const state = new ProcessedState();
    const p = makeFilePath('has-entry');

    expect(state.hasEntry(p)).toBe(false);

    await state.markProcessed(p, Date.now(), 5, ['/vault/note.md']);

    state.reload();
    expect(state.hasEntry(p)).toBe(true);
  });

  it('shouldProcess: 미등록→true, 같은 mtime→false, 더 큰 mtime→true', async () => {
    const state = new ProcessedState();
    const p = makeFilePath('should-process');
    const mtime = 1000000;

    expect(state.shouldProcess(p, mtime)).toBe(true);

    await state.markProcessed(p, mtime, 5, []);
    state.reload();

    expect(state.shouldProcess(p, mtime)).toBe(false);
    expect(state.shouldProcess(p, mtime + 1)).toBe(true);
  });

  it('markProcessed → getProcessedMessageCount: 올바른 카운트 반환', async () => {
    const state = new ProcessedState();
    const p = makeFilePath('msg-count');

    await state.markProcessed(p, 1000, 7, []);
    state.reload();

    expect(state.getProcessedMessageCount(p)).toBe(7);
  });

  it('markProcessed → getLastProcessedUuid: 올바른 uuid 반환', async () => {
    const state = new ProcessedState();
    const p = makeFilePath('last-uuid');
    const uuid = 'test-uuid-1234';

    await state.markProcessed(p, 1000, 3, [], uuid);
    state.reload();

    expect(state.getLastProcessedUuid(p)).toBe(uuid);
  });

  it('markSkipped: 새 경로에 skipped=true 설정, 처리된 항목은 같은 mtime이면 덮어쓰지 않음', async () => {
    const state = new ProcessedState();
    const p = makeFilePath('skipped');
    const mtime = 2000;

    // 완전 처리 후 같은 mtime으로 markSkipped → 덮어쓰지 않음
    await state.markProcessed(p, mtime, 10, ['/vault/note.md']);
    state.reload();

    await state.markSkipped(p, mtime);
    state.reload();

    // processedMessageCount는 여전히 10 (덮어쓰지 않았으므로)
    expect(state.getProcessedMessageCount(p)).toBe(10);

    // 새 경로에서 markSkipped 테스트
    const p2 = makeFilePath('skipped-new');
    await state.markSkipped(p2, 3000);
    state.reload();
    expect(state.hasEntry(p2)).toBe(true);
    expect(state.getProcessedMessageCount(p2)).toBe(0);
  });

  it('seedFiles: 새 항목 추가, 기존 항목 덮어쓰지 않음', async () => {
    const state = new ProcessedState();
    const p1 = makeFilePath('seed-1');
    const p2 = makeFilePath('seed-2');

    // p1은 미리 처리
    await state.markProcessed(p1, 500, 3, ['/note.md']);
    state.reload();

    await state.seedFiles([
      { filePath: p1, mtime: 999, messageCount: 99 }, // 기존 항목 → 무시
      { filePath: p2, mtime: 1000, messageCount: 5 },  // 새 항목 → 추가
    ]);
    state.reload();

    // p1은 기존 값 유지
    expect(state.getProcessedMessageCount(p1)).toBe(3);
    // p2는 새로 추가됨
    expect(state.getProcessedMessageCount(p2)).toBe(5);
  });

  it('getPendingSiblingContext: 형제 컨텍스트 반환, 자신은 제외', async () => {
    const state = new ProcessedState();
    const dir = '/fake/project';
    const self = `${dir}/self.jsonl`;
    const sibling = `${dir}/sibling.jsonl`;
    const other = '/other/project/other.jsonl';

    await (state as any).withStateLock((data: any) => {
      data.entries[sibling] = {
        mtime: 1000, processedMessageCount: 0, noteFiles: [],
        processedAt: new Date().toISOString(),
        pendingContext: '이전 세션 컨텍스트',
        pendingAt: new Date().toISOString(),
      };
      data.entries[other] = {
        mtime: 1000, processedMessageCount: 0, noteFiles: [],
        processedAt: new Date().toISOString(),
        pendingContext: '다른 프로젝트 컨텍스트',
        pendingAt: new Date().toISOString(),
      };
    });
    state.reload();

    const ctx = state.getPendingSiblingContext(self);
    expect(ctx).toContain('이전 세션 컨텍스트');
    expect(ctx).not.toContain('다른 프로젝트 컨텍스트');
  });

  it('clearSiblingPendingContext: 형제의 pendingContext 제거', async () => {
    const state = new ProcessedState();
    const dir = '/fake/project';
    const self = `${dir}/main.jsonl`;
    const sibling = `${dir}/sibling.jsonl`;

    await (state as any).withStateLock((data: any) => {
      data.entries[sibling] = {
        mtime: 1000, processedMessageCount: 0, noteFiles: [],
        processedAt: new Date().toISOString(),
        pendingContext: '컨텍스트 데이터',
        pendingAt: new Date().toISOString(),
      };
    });
    state.reload();

    await state.clearSiblingPendingContext(self);
    state.reload();

    const ctx = state.getPendingSiblingContext(self);
    expect(ctx).toBeUndefined();
  });

  it('needsGc: 한 번도 안 실행→true, 24h 이내→false', async () => {
    const state = new ProcessedState();

    expect(state.needsGc()).toBe(true);

    // lastGcAt을 현재 시간으로 설정
    await (state as any).withStateLock((data: any) => {
      data.lastGcAt = new Date().toISOString();
    });
    state.reload();

    expect(state.needsGc()).toBe(false);
  });

  it('gcStaleEntries: 디스크에 없는 파일 항목 제거', async () => {
    const state = new ProcessedState();
    const existing = path.join(TEST_HOME, 'real-file.jsonl');
    const ghost = '/nonexistent/path/ghost.jsonl';

    // 실제 파일 생성
    fs.writeFileSync(existing, '', 'utf-8');

    await state.markProcessed(existing, 1000, 5, []);
    await state.markProcessed(ghost, 1000, 3, []);
    state.reload();

    expect(state.hasEntry(existing)).toBe(true);
    expect(state.hasEntry(ghost)).toBe(true);

    await state.gcStaleEntries();
    state.reload();

    expect(state.hasEntry(existing)).toBe(true);  // 실제 파일 → 유지
    expect(state.hasEntry(ghost)).toBe(false);     // 없는 파일 → 제거

    fs.unlinkSync(existing);
  });

  it('reload(): 외부 변경사항 반영', async () => {
    const state = new ProcessedState();
    const stateFile = path.join(TEST_HOME, '.vsc-secondbrain', 'state.json');
    const p = makeFilePath('reload-test');

    // 외부에서 직접 state.json 수정
    const externalData = {
      version: 1,
      entries: {
        [p]: {
          mtime: 9999,
          processedMessageCount: 42,
          noteFiles: ['/external/note.md'],
          processedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(externalData), 'utf-8');

    // reload 전에는 인식 못함
    expect(state.hasEntry(p)).toBe(false);

    // reload 후 반영
    state.reload();
    expect(state.hasEntry(p)).toBe(true);
    expect(state.getProcessedMessageCount(p)).toBe(42);
  });
});
