import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeWatcher } from './ClaudeWatcher';
import {
  FakeSummarizer, makeSummaryResult,
  createTempWorkspace, writeJsonlFile, makeIntegrationConfig,
  findNoteFiles, makeStatusBar, makeLogger, makeApiKeyManager,
} from '../__test-utils__/integration-helpers';

// 그룹 1: E2E 파이프라인
describe('E2E 파이프라인', () => {
  let ws: ReturnType<typeof createTempWorkspace>;
  let fakeSummarizer: FakeSummarizer;

  beforeEach(() => {
    ws = createTempWorkspace();
    fakeSummarizer = new FakeSummarizer();
  });

  afterEach(() => {
    ws.cleanup();
  });

  // 테스트 1: processFile → FakeSummarizer → NoteWriter → state 갱신 검증
  it('processFile → 노트 생성 → state 갱신', async () => {
    // 프로젝트 폴더 생성 (projects/{encoded-name}/session.jsonl)
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '안녕하세요' },
      { role: 'assistant', content: '안녕하세요! 무엇을 도와드릴까요?' },
    ]);

    const config = makeIntegrationConfig(ws.vaultDir);
    const watcher = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fakeSummarizer,
      ws.stateDir,
    );

    await watcher.processFile(jsonlPath, true);

    // Summarizer가 호출되었는지 확인
    expect(fakeSummarizer.callCount).toBe(1);

    // 노트 파일이 생성되었는지 확인
    const notes = findNoteFiles(ws.vaultDir);
    expect(notes.length).toBeGreaterThan(0);
    // 노트 내용에 title이 포함되어 있는지
    const noteContent = fs.readFileSync(notes[0], 'utf-8');
    expect(noteContent).toContain('Test Summary');
  });

  // 테스트 2: 증분 처리 — 2차 processFile은 새 메시지만 전달
  it('증분 처리: 2차 processFile은 새 메시지만 전달', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '첫 번째 메시지' },
      { role: 'assistant', content: '첫 번째 응답' },
    ]);

    const config = makeIntegrationConfig(ws.vaultDir);
    const watcher = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fakeSummarizer,
      ws.stateDir,
    );

    // 1차 처리
    await watcher.processFile(jsonlPath, true);
    expect(fakeSummarizer.callCount).toBe(1);
    const firstSessionMsgs = fakeSummarizer.lastSession!.messages.length;

    // jsonl에 새 메시지 추가 — Claude CLI 실제 포맷으로 작성
    const extraMessages = [
      { role: 'user' as const, content: '추가 질문' },
      { role: 'assistant' as const, content: '추가 응답' },
    ];
    const currentContent = fs.readFileSync(jsonlPath, 'utf-8');
    // 기존 파일의 sessionId를 추출하여 동일 세션으로 이어 붙임
    const firstLine = JSON.parse(currentContent.split('\n')[0]);
    const sessionId = firstLine.sessionId as string;
    const baseTime = Date.now();
    const newLines = extraMessages.map((m, i) => JSON.stringify({
      type: m.role === 'user' ? 'user' : 'assistant',
      uuid: `uuid-extra-${i}`,
      timestamp: new Date(baseTime + i * 1000).toISOString(),
      sessionId,
      cwd: '/tmp/test-project',
      message: {
        role: m.role,
        content: [{ type: 'text', text: m.content }],
      },
    }));
    fs.writeFileSync(jsonlPath, currentContent + newLines.join('\n') + '\n', 'utf-8');
    // mtime 갱신 (2초 뒤 시점 — 파일시스템 정밀도 보장)
    const newMtime = new Date(Date.now() + 2000);
    fs.utimesSync(jsonlPath, newMtime, newMtime);

    // 2차 처리
    await watcher.processFile(jsonlPath, true);
    expect(fakeSummarizer.callCount).toBe(2);

    // 2차 호출에서 전달된 메시지가 새 메시지만인지 확인
    const secondSessionMsgs = fakeSummarizer.lastSession!.messages.length;
    expect(secondSessionMsgs).toBeLessThan(firstSessionMsgs + extraMessages.length);
    expect(secondSessionMsgs).toBeGreaterThan(0);
  });

  // 테스트 3: minMessages 미만 → markSkipped + 노트 미생성
  it('minMessages 미만 → skipped 처리, 노트 미생성', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    // 1개 메시지 (minMessages=2 미만)
    const jsonlPath = writeJsonlFile(projDir, 'session.jsonl', [
      { role: 'user', content: '짧은 대화' },
    ]);

    const config = makeIntegrationConfig(ws.vaultDir);
    const watcher = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fakeSummarizer,
      ws.stateDir,
    );

    await watcher.processFile(jsonlPath, true);

    expect(fakeSummarizer.callCount).toBe(0);
    const notes = findNoteFiles(ws.vaultDir);
    expect(notes.length).toBe(0);
  });
});

// 그룹 2: 에러 복구
describe('에러 복구', () => {
  let ws: ReturnType<typeof createTempWorkspace>;
  let fakeSummarizer: FakeSummarizer;

  beforeEach(() => {
    ws = createTempWorkspace();
    fakeSummarizer = new FakeSummarizer();
  });

  afterEach(() => {
    ws.cleanup();
  });

  // 테스트 4: Summarizer 에러 → state 미변경 + 재처리 가능
  it('Summarizer 에러 → 노트 미생성, 재처리 가능', async () => {
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
      () => fakeSummarizer,
      ws.stateDir,
    );

    // 1차 처리 — 에러 발생
    fakeSummarizer.shouldThrow = new Error('API 오류');
    await watcher.processFile(jsonlPath, true);
    expect(findNoteFiles(ws.vaultDir).length).toBe(0);

    // 에러 해제 후 재처리
    fakeSummarizer.shouldThrow = undefined;
    await watcher.processFile(jsonlPath, true);
    expect(fakeSummarizer.callCount).toBe(2);
    expect(findNoteFiles(ws.vaultDir).length).toBeGreaterThan(0);
  });

  // 테스트 5: 깨진 JSONL → 파싱 실패 → 노트 미생성
  it('깨진 JSONL → 파싱 실패 → 노트 미생성', async () => {
    const projDir = path.join(ws.projectsDir, 'test-project');
    fs.mkdirSync(projDir, { recursive: true });
    const jsonlPath = path.join(projDir, 'broken.jsonl');
    fs.writeFileSync(jsonlPath, 'NOT VALID JSON\n', 'utf-8');

    const config = makeIntegrationConfig(ws.vaultDir);
    const watcher = new ClaudeWatcher(
      config as any,
      makeApiKeyManager() as any,
      makeStatusBar() as any,
      makeLogger() as any,
      undefined,
      () => fakeSummarizer,
      ws.stateDir,
    );

    await watcher.processFile(jsonlPath, true);
    expect(fakeSummarizer.callCount).toBe(0);
    expect(findNoteFiles(ws.vaultDir).length).toBe(0);
  });
});
