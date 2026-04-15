import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeWatcher } from './ClaudeWatcher';
import { ProcessedState } from '../state/ProcessedState';
import {
  FakeSummarizer,
  createTempWorkspace,
  writeJsonlFile,
  makeIntegrationConfig,
  makeStatusBar,
  makeLogger,
  makeApiKeyManager,
} from '../__test-utils__/integration-helpers';

// 그룹 5: init과 watcher 이벤트 경쟁
describe('초기화-watcher 경쟁 조건', () => {
  let ws: ReturnType<typeof createTempWorkspace>;
  let fake: FakeSummarizer;

  beforeEach(() => {
    ws = createTempWorkspace();
    fake = new FakeSummarizer();
  });

  afterEach(() => {
    ws.cleanup();
  });

  // 테스트 1: dirtyFiles에 있는 파일은 seed 대상에서 제외됨
  it('dirtyFiles에 있는 파일은 initializeExistingFiles가 seed하지 않음', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '응답' },
    ]);

    const config = makeIntegrationConfig(ws.vaultDir);
    const watcher = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fake,
      ws.stateDir,
    );

    // initializeExistingFiles 호출 전에 dirtyFiles에 미리 추가 (watcher 이벤트 시뮬레이션)
    (watcher as any).dirtyFiles.add(jsonlPath);

    // initializeExistingFiles를 직접 호출 (watchPath = projectsDir)
    await (watcher as any).initializeExistingFiles(ws.projectsDir);

    // dirtyFiles에 있었던 파일은 seed되지 않아야 함 — state.hasEntry가 false여야 함
    const state: ProcessedState = (watcher as any).state;
    expect(state.hasEntry(jsonlPath)).toBe(false);

    // dirtyFiles는 여전히 해당 파일을 보유
    expect((watcher as any).dirtyFiles.has(jsonlPath)).toBe(true);
  });

  // 테스트 2: init 중 dirty가 아닌 새 파일은 seed됨
  it('dirtyFiles에 없는 새 파일은 initializeExistingFiles가 seed함', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '응답' },
    ]);

    const config = makeIntegrationConfig(ws.vaultDir);
    const watcher = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fake,
      ws.stateDir,
    );

    // dirtyFiles에 추가하지 않음
    await (watcher as any).initializeExistingFiles(ws.projectsDir);

    // 새 파일은 seed되어야 함
    const state: ProcessedState = (watcher as any).state;
    expect(state.hasEntry(jsonlPath)).toBe(true);

    // seed된 파일은 dirtyFiles에 없어야 함
    expect((watcher as any).dirtyFiles.has(jsonlPath)).toBe(false);
  });

  // 테스트 3: mtime이 변경된 기존 파일 → init이 dirtyFiles에 추가
  it('mtime 변경된 기존 파일 → initializeExistingFiles가 dirtyFiles에 추가', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '응답' },
    ]);

    const config = makeIntegrationConfig(ws.vaultDir);
    const watcher = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fake,
      ws.stateDir,
    );

    // state에 오래된 mtime으로 미리 기록
    const state: ProcessedState = (watcher as any).state;
    await state.seedFiles([{ filePath: jsonlPath, mtime: 1000, messageCount: 2 }]);

    // 현재 mtime > 1000이므로 shouldProcess=true
    await (watcher as any).initializeExistingFiles(ws.projectsDir);

    // dirtyFiles에 추가되어야 함
    expect((watcher as any).dirtyFiles.has(jsonlPath)).toBe(true);
  });
});
