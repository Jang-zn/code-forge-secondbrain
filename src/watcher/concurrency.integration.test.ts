import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { ClaudeWatcher } from './ClaudeWatcher';
import {
  FakeSummarizer,
  createTempWorkspace,
  writeJsonlFile,
  makeIntegrationConfig,
  findNoteFiles,
  makeStatusBar,
  makeLogger,
  makeApiKeyManager,
} from '../__test-utils__/integration-helpers';

// 그룹 3: 멀티 윈도우 동시성
describe('멀티 윈도우 동시성', () => {
  let ws: ReturnType<typeof createTempWorkspace>;

  beforeEach(() => {
    ws = createTempWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  // 테스트 1: 동일 파일 동시 processFile → 하나만 성공
  it('동일 파일 동시 processFile → 하나만 성공', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '응답' },
    ]);

    const config = makeIntegrationConfig(ws.vaultDir);
    // 두 watcher가 같은 stateDir 공유 (멀티 윈도우 시뮬레이션)
    const fake1 = new FakeSummarizer();
    const fake2 = new FakeSummarizer();
    fake1.delay = 50;
    fake2.delay = 50;

    const watcher1 = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fake1,
      ws.stateDir,
    );
    const watcher2 = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fake2,
      ws.stateDir,
    );

    // 동시 실행
    await Promise.all([
      watcher1.processFile(jsonlPath, true),
      watcher2.processFile(jsonlPath, true),
    ]);

    // 정확히 하나만 summarizer를 호출해야 함 (FileLock으로 하나가 블로킹)
    const totalCalls = fake1.callCount + fake2.callCount;
    expect(totalCalls).toBe(1);
  });

  // 테스트 2: 다른 파일 동시 processFile → 둘 다 성공
  it('다른 파일 동시 processFile → 둘 다 성공', async () => {
    const proj1Dir = path.join(ws.projectsDir, 'project-one');
    const proj2Dir = path.join(ws.projectsDir, 'project-two');
    const jsonl1 = writeJsonlFile(proj1Dir, 'session.jsonl', [
      { role: 'user', content: '첫 프로젝트 질문' },
      { role: 'assistant', content: '첫 프로젝트 응답' },
    ]);
    const jsonl2 = writeJsonlFile(proj2Dir, 'session.jsonl', [
      { role: 'user', content: '두 번째 프로젝트 질문' },
      { role: 'assistant', content: '두 번째 프로젝트 응답' },
    ]);

    const config = makeIntegrationConfig(ws.vaultDir);
    const fake1 = new FakeSummarizer();
    const fake2 = new FakeSummarizer();

    const watcher1 = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fake1,
      ws.stateDir,
    );
    const watcher2 = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fake2,
      ws.stateDir,
    );

    await Promise.all([
      watcher1.processFile(jsonl1, true),
      watcher2.processFile(jsonl2, true),
    ]);

    // 둘 다 호출되어야 함
    expect(fake1.callCount).toBe(1);
    expect(fake2.callCount).toBe(1);
    const notes = findNoteFiles(ws.vaultDir);
    expect(notes.length).toBe(2);
  });
});

// 그룹 4: batchInProgress 가드
describe('batchInProgress 가드', () => {
  let ws: ReturnType<typeof createTempWorkspace>;

  beforeEach(() => {
    ws = createTempWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  // 테스트 3: batch 중 runScheduled → processFile 미호출
  it('batchInProgress=true → runScheduled가 processFile을 호출하지 않음', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '응답' },
    ]);

    const fake = new FakeSummarizer();
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

    // batchInProgress 강제 설정
    (watcher as any).batchInProgress = true;
    (watcher as any).dirtyFiles.add(jsonlPath);

    await (watcher as any).runScheduled();

    // 파일이 dirtyFiles에 있고 batchInProgress=true이면 processFile 미호출
    expect(fake.callCount).toBe(0);
  });

  // 테스트 4: batch 완료 후 runScheduled → dirtyFiles 처리
  it('batchInProgress=false → runScheduled가 dirtyFiles 처리', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '응답' },
    ]);

    const fake = new FakeSummarizer();
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

    // batchInProgress=false (기본값)
    (watcher as any).dirtyFiles.add(jsonlPath);

    await (watcher as any).runScheduled();

    // runScheduled가 processFile을 호출해야 함
    expect(fake.callCount).toBe(1);
  });
});
