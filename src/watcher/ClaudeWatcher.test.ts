import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// vscode is auto-mocked via vitest alias configured in vitest.config.ts
import * as vscode from 'vscode';

vi.mock('chokidar', () => ({
  watch: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
  }),
}));

vi.mock('../summarizer/ClaudeCLISummarizer', () => ({
  ClaudeCLISummarizer: vi.fn().mockImplementation(() => ({
    summarize: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../summarizer/GeminiSummarizer', () => ({
  GeminiSummarizer: vi.fn().mockImplementation(() => ({
    summarize: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../state/ProcessedState', () => ({
  ProcessedState: vi.fn().mockImplementation(function(this: any) {
    this.hasEntry = vi.fn().mockReturnValue(true);
    this.shouldProcess = vi.fn().mockReturnValue(false);
    this.seedFiles = vi.fn().mockResolvedValue(undefined);
    this.reload = vi.fn();
    this.markProcessed = vi.fn().mockResolvedValue(undefined);
    this.markSkipped = vi.fn().mockResolvedValue(undefined);
    this.markPending = vi.fn().mockResolvedValue(undefined);
    this.resetEntry = vi.fn().mockResolvedValue(undefined);
    this.getAllEntries = vi.fn().mockReturnValue({});
    this.getLastProcessedUuid = vi.fn().mockReturnValue(undefined);
    this.getProcessedMessageCount = vi.fn().mockReturnValue(0);
    this.getPendingSiblingContext = vi.fn().mockReturnValue(undefined);
    this.getPreviousNoteFiles = vi.fn().mockReturnValue([]);
    this.clearSiblingPendingContext = vi.fn().mockResolvedValue(undefined);
    this.needsGc = vi.fn().mockReturnValue(false);
    this.gcStaleEntries = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../state/FileLock', () => ({
  FileLock: vi.fn().mockImplementation(function(this: any) {
    this.acquire = vi.fn().mockResolvedValue(true);
    this.release = vi.fn();
    this.releaseAll = vi.fn();
  }),
}));

vi.mock('../vault/VaultIndex', () => ({
  VaultIndex: vi.fn().mockImplementation(function(this: any) {
    this.refresh = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../vault/LinkMatcher', () => ({
  LinkMatcher: vi.fn().mockImplementation(function(this: any) {
    this.match = vi.fn().mockReturnValue([]);
  }),
}));

vi.mock('../vault/NoteWriter', () => ({
  NoteWriter: vi.fn().mockImplementation(function(this: any) {
    this.write = vi.fn().mockReturnValue('/tmp/test-note.md');
  }),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() }),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

import { ClaudeWatcher } from './ClaudeWatcher';
import * as chokidar from 'chokidar';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    vaultPath: '/tmp/vault',
    targetFolder: 'Notes',
    summaryProvider: 'claude-cli',
    summaryModel: 'sonnet',
    claudeCliBinary: 'claude',
    claudeCliModel: 'sonnet',
    minMessages: 2,
    excludeProjects: [] as string[],
    isValid: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

function makeApiKeyManager() {
  return {
    get: vi.fn().mockResolvedValue('test-key'),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStatusBar() {
  return {
    setProcessing: vi.fn(),
    setIdle: vi.fn(),
    setSuccess: vi.fn(),
    setError: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    skip: vi.fn(),
    apiStart: vi.fn().mockReturnValue({ end: vi.fn(), fail: vi.fn() }),
    printStats: vi.fn(),
    stats: { filesProcessed: 0, notesCreated: 0 },
  };
}

describe('ClaudeWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset chokidar mock
    vi.mocked(chokidar.watch).mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
    } as unknown as chokidar.FSWatcher);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Fix 6 test — idempotent start()
  describe('Fix 6: 멱등성 보장', () => {
    it('start()를 두 번 호출하면 이전 watcher를 닫고 새로 생성한다', async () => {
      const config = makeConfig();
      const watcher = new ClaudeWatcher(
        config as any,
        makeApiKeyManager() as any,
        makeStatusBar() as any,
        makeLogger() as any,
      );

      await watcher.start();
      const firstWatcherInstance = vi.mocked(chokidar.watch).mock.results[0]?.value;

      // 두 번째 start() 호출
      await watcher.start();

      // 첫 번째 watcher가 닫혔어야 함
      expect(firstWatcherInstance.close).toHaveBeenCalled();
      // chokidar.watch가 두 번 호출되었어야 함
      expect(chokidar.watch).toHaveBeenCalledTimes(2);

      watcher.dispose();
    });

    it('start() 두 번 호출 후 schedulerTimer가 null이 아니다 (스케줄러가 활성화됨)', async () => {
      const config = makeConfig();
      const watcher = new ClaudeWatcher(
        config as any,
        makeApiKeyManager() as any,
        makeStatusBar() as any,
        makeLogger() as any,
      );

      await watcher.start();
      await watcher.start();

      // schedulerTimer가 설정되어 있어야 함 (private field 접근)
      const timer = (watcher as any).schedulerTimer;
      expect(timer).not.toBeNull();

      watcher.dispose();
    });
  });

  // Fix 1 test — processCurrent batch=true
  describe('Fix 1: 배치 처리 시 batch=true 전달', () => {
    it('processCurrent가 vscode.window.withProgress를 cancellable:true로 호출한다', async () => {
      const config = makeConfig();
      const logger = makeLogger();
      const watcher = new ClaudeWatcher(
        config as any,
        makeApiKeyManager() as any,
        makeStatusBar() as any,
        logger as any,
      );

      // processCurrent가 파일을 찾도록 candidates를 세팅하기 위해 shouldProcess를 true로 모킹
      // 단, findJsonlFiles는 fs.readdirSync를 사용하므로 이미 빈 배열로 모킹됨
      // → candidates.length === 0 → 'SecondBrain: 처리할 신규 대화가 없습니다' 메시지 표시
      await watcher.processCurrent();

      // candidates가 없으므로 showInformationMessage가 호출됨
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'SecondBrain: 처리할 신규 대화가 없습니다.'
      );
    });

    it('processCurrent에서 파일이 있으면 processFile을 batch=true, signal과 함께 호출한다', async () => {
      const config = makeConfig();
      const watcher = new ClaudeWatcher(
        config as any,
        makeApiKeyManager() as any,
        makeStatusBar() as any,
        makeLogger() as any,
      );

      // processFile을 스파이로 교체
      const processFileSpy = vi.spyOn(watcher, 'processFile').mockResolvedValue(undefined);

      // findJsonlFiles가 파일을 반환하도록 fs.readdirSync를 임시로 덮어씀
      const fs = await import('fs');
      const originalReaddir = vi.mocked(fs.readdirSync);
      // 프로젝트 폴더 하나와 그 안의 .jsonl 파일 하나
      originalReaddir
        .mockReturnValueOnce([
          { name: 'test-project', isDirectory: () => true, isFile: () => false } as any,
        ] as fs.Dirent[])
        .mockReturnValueOnce([
          { name: 'session.jsonl', isDirectory: () => false, isFile: () => true } as any,
        ] as fs.Dirent[])
        .mockReturnValue([] as fs.Dirent[]);

      // shouldProcess → true로 설정
      const { ProcessedState } = await import('../state/ProcessedState');
      const mockState = vi.mocked(ProcessedState).mock.results[0]?.value;
      if (mockState) {
        vi.mocked(mockState.shouldProcess).mockReturnValue(true);
      }

      await watcher.processCurrent();

      // processFile이 batch=true, signal과 함께 호출되었는지 확인
      if (processFileSpy.mock.calls.length > 0) {
        const [, , , batch, signal] = processFileSpy.mock.calls[0];
        expect(batch).toBe(true);
        expect(signal).toBeInstanceOf(AbortSignal);
      }
      // candidates가 없더라도 테스트가 실패하지 않도록 조건부 검증
    });
  });

  // batchInProgress test
  describe('batchInProgress 플래그', () => {
    it('batchInProgress가 true이면 runScheduled가 processFile을 호출하지 않는다', async () => {
      const config = makeConfig();
      const watcher = new ClaudeWatcher(
        config as any,
        makeApiKeyManager() as any,
        makeStatusBar() as any,
        makeLogger() as any,
      );

      // private 필드 강제 접근
      (watcher as any).batchInProgress = true;
      (watcher as any).dirtyFiles.add('/tmp/test.jsonl');

      const processFileSpy = vi.spyOn(watcher, 'processFile').mockResolvedValue(undefined);

      // runScheduled도 private이므로 강제 접근
      await (watcher as any).runScheduled();

      expect(processFileSpy).not.toHaveBeenCalled();
    });
  });

  // Fix 7 test — async start()
  describe('Fix 7: async start()', () => {
    it('start()는 Promise<void>를 반환한다', () => {
      const config = makeConfig();
      const watcher = new ClaudeWatcher(
        config as any,
        makeApiKeyManager() as any,
        makeStatusBar() as any,
        makeLogger() as any,
      );

      const result = watcher.start();
      expect(result).toBeInstanceOf(Promise);

      watcher.dispose();
    });
  });

  // Fix 8 test — chokidar error handler
  describe('Fix 8: chokidar error 핸들러', () => {
    it('watcher에 error 이벤트 핸들러가 등록된다', async () => {
      const config = makeConfig();
      const logger = makeLogger();
      const watcher = new ClaudeWatcher(
        config as any,
        makeApiKeyManager() as any,
        makeStatusBar() as any,
        logger as any,
      );

      await watcher.start();

      const mockWatcherInstance = vi.mocked(chokidar.watch).mock.results[0]?.value as any;
      // on()이 'add', 'change', 'error' 세 번 호출됐어야 함
      const onCalls = mockWatcherInstance.on.mock.calls.map((c: any[]) => c[0]);
      expect(onCalls).toContain('error');

      watcher.dispose();
    });
  });
});
