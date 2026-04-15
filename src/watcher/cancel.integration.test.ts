import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { ClaudeWatcher } from './ClaudeWatcher';
import {
  FakeSummarizer, createTempWorkspace, writeJsonlFile, makeIntegrationConfig,
  findNoteFiles, makeStatusBar, makeLogger, makeApiKeyManager,
} from '../__test-utils__/integration-helpers';

// 그룹 6: 취소 타이밍
describe('취소 타이밍', () => {
  let ws: ReturnType<typeof createTempWorkspace>;

  beforeEach(() => {
    ws = createTempWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  // 테스트 1: AbortSignal 전달 시 처리 중단
  it('AbortSignal abort → summarizer 중단', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '응답' },
    ]);

    const fake = new FakeSummarizer();
    fake.delay = 200; // 처리 지연

    const config = makeIntegrationConfig(ws.vaultDir);
    const watcher = new ClaudeWatcher(
      config as any, makeApiKeyManager() as any, makeStatusBar() as any,
      makeLogger() as any, undefined, () => fake, ws.stateDir,
    );

    const controller = new AbortController();
    // 50ms 후 취소
    setTimeout(() => controller.abort(), 50);

    // processFile은 에러 없이 종료해야 함 (취소됨 에러를 내부에서 처리)
    await expect(
      watcher.processFile(jsonlPath, true, false, false, controller.signal)
    ).resolves.toBeUndefined();

    // 취소로 인해 노트가 생성되지 않아야 함
    expect(findNoteFiles(ws.vaultDir).length).toBe(0);
  });

  // 테스트 2: 취소 후 재실행 → 정상 처리
  it('취소 후 AbortSignal 없이 재실행 → 노트 생성', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '응답' },
    ]);

    const fake = new FakeSummarizer();
    fake.delay = 200;

    const config = makeIntegrationConfig(ws.vaultDir);
    const watcher = new ClaudeWatcher(
      config as any, makeApiKeyManager() as any, makeStatusBar() as any,
      makeLogger() as any, undefined, () => fake, ws.stateDir,
    );

    // 1차: 취소
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await watcher.processFile(jsonlPath, true, false, false, controller.signal);
    expect(findNoteFiles(ws.vaultDir).length).toBe(0);

    // 2차: 취소 없이 재실행 — delay 제거, forceReprocess=true로 state 재처리 강제
    fake.delay = 0;
    await watcher.processFile(jsonlPath, true, true);
    expect(findNoteFiles(ws.vaultDir).length).toBeGreaterThan(0);
  });
});

// 그룹 7: 런타임 설정 변경
describe('런타임 설정 변경', () => {
  let ws: ReturnType<typeof createTempWorkspace>;

  beforeEach(() => {
    ws = createTempWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  // 테스트 3: config.enabled=false → onFileChange가 dirtyFiles에 추가하지 않음
  it('config.enabled=false → 파일 변경 이벤트 무시', () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = path.join(projDir, 'session.jsonl');

    const config = { ...makeIntegrationConfig(ws.vaultDir), enabled: false };
    const watcher = new ClaudeWatcher(
      config as any, makeApiKeyManager() as any, makeStatusBar() as any,
      makeLogger() as any, undefined, undefined, ws.stateDir,
    );

    // onFileChange는 private이므로 직접 호출
    (watcher as any).onFileChange(jsonlPath);

    // enabled=false이면 dirtyFiles에 추가 안됨
    expect((watcher as any).dirtyFiles.has(jsonlPath)).toBe(false);
  });

  // 테스트 4: excludeProjects 설정 → 해당 프로젝트 파일 skip
  it('excludeProjects 패턴 → 해당 프로젝트 processFile 스킵', async () => {
    const projDir = path.join(ws.projectsDir, '-Users-test-secret-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '응답' },
    ]);

    const fake = new FakeSummarizer();
    const config = makeIntegrationConfig(ws.vaultDir, {
      excludeProjects: ['secret-project'],
    });
    const watcher = new ClaudeWatcher(
      config as any, makeApiKeyManager() as any, makeStatusBar() as any,
      makeLogger() as any, undefined, () => fake, ws.stateDir,
    );

    // isExcludedProject로 스킵되는지 확인
    const isExcluded = (watcher as any).isExcludedProject(jsonlPath);
    expect(isExcluded).toBe(true);

    // processFile은 config.isValid() 실패 전에 excludeProjects 체크를 하지 않음
    // (excludeProjects는 watcher 이벤트와 runScheduled에서 체크)
    // onFileChange 직접 테스트
    (watcher as any).onFileChange(jsonlPath);
    expect((watcher as any).dirtyFiles.has(jsonlPath)).toBe(false);
  });
});
