import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonlParser } from './JsonlParser';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

function writeTmpJsonl(lines: object[]): string {
  const filePath = path.join(tmpDir, `test-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  return filePath;
}

function writeTmpRaw(content: string): string {
  const filePath = path.join(tmpDir, `test-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonlparser-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const parser = new JsonlParser();

// 헬퍼: user 레코드 생성
function makeUser(uuid: string, content: string | object[], sessionId = 's1', ts = '2024-01-01T10:00:00Z') {
  return { type: 'user', uuid, timestamp: ts, sessionId, cwd: '/test', message: { role: 'user', content } };
}

// 헬퍼: assistant 레코드 생성
function makeAssistant(uuid: string, content: object[], sessionId = 's1', ts = '2024-01-01T10:01:00Z') {
  return { type: 'assistant', uuid, timestamp: ts, sessionId, cwd: '/test', message: { role: 'assistant', content } };
}

describe('JsonlParser', () => {
  // 1. 정상 대화 파싱
  it('user + assistant 메시지를 올바르게 파싱한다', () => {
    const filePath = writeTmpJsonl([
      makeUser('u1', 'hello'),
      makeAssistant('a1', [{ type: 'text', text: 'hi there' }]),
    ]);

    const result = parser.parse(filePath);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('s1');
    expect(result!.projectPath).toBe('/test');
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0].role).toBe('user');
    expect(result!.messages[0].content).toBe('hello');
    expect(result!.messages[0].timestamp).toBe('2024-01-01T10:00:00Z');
    expect(result!.messages[1].role).toBe('assistant');
    expect(result!.messages[1].content).toBe('hi there');
  });

  // 2. 빈 파일 → null
  it('빈 파일은 null을 반환한다', () => {
    const filePath = writeTmpRaw('');
    expect(parser.parse(filePath)).toBeNull();
  });

  // 3. 공백/빈 줄만 있으면 null
  it('공백/빈 줄만 있으면 null을 반환한다', () => {
    const filePath = writeTmpRaw('   \n\n   \n');
    expect(parser.parse(filePath)).toBeNull();
  });

  // 4. 깨진 JSON 줄은 건너뛰고 유효한 줄은 파싱
  it('깨진 JSON 줄은 건너뛰고 유효한 줄은 파싱한다', () => {
    const filePath = writeTmpRaw([
      JSON.stringify(makeUser('u1', 'hello')),
      'NOT_VALID_JSON{{{{',
      JSON.stringify(makeAssistant('a1', [{ type: 'text', text: 'ok' }])),
    ].join('\n'));

    const result = parser.parse(filePath);
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
  });

  // 5. thinking 블록은 무시됨
  it('thinking 블록은 무시되고 text만 파싱된다', () => {
    const filePath = writeTmpJsonl([
      makeUser('u1', 'question'),
      makeAssistant('a1', [
        { type: 'thinking', thinking: 'internal reasoning...' },
        { type: 'text', text: 'the answer' },
      ]),
    ]);

    const result = parser.parse(filePath);
    expect(result).not.toBeNull();
    const assistantMsg = result!.messages.find(m => m.role === 'assistant');
    expect(assistantMsg!.content).toBe('the answer');
    expect(assistantMsg!.content).not.toContain('internal reasoning');
  });

  // 6. tool_use 블록은 toolCall을 만들고 tool_result는 resultDigest로 연결
  it('tool_use는 toolCall을 생성하고 tool_result는 resultDigest로 연결된다', () => {
    const filePath = writeTmpJsonl([
      makeUser('u1', 'run ls'),
      makeAssistant('a1', [
        { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'ls' } },
      ]),
      makeUser('u2', [
        { type: 'tool_result', tool_use_id: 'tool1', content: 'file.txt\nfoo.ts', is_error: false },
      ]),
    ]);

    const result = parser.parse(filePath);
    expect(result).not.toBeNull();
    const assistantMsg = result!.messages.find(m => m.role === 'assistant');
    expect(assistantMsg!.toolCalls).toBeDefined();
    expect(assistantMsg!.toolCalls![0].name).toBe('Bash');
    expect(assistantMsg!.toolCalls![0].inputDigest).toContain('cmd=ls');
    expect(assistantMsg!.toolCalls![0].resultDigest).toBeDefined();
  });

  // 7. isMeta: true user 메시지는 건너뜀
  it('isMeta: true인 user 메시지는 건너뛴다', () => {
    const filePath = writeTmpJsonl([
      { ...makeUser('u1', 'system init'), isMeta: true },
      makeAssistant('a1', [{ type: 'text', text: 'response' }]),
    ]);

    const result = parser.parse(filePath);
    expect(result).not.toBeNull();
    // user 메시지가 건너뛰어졌으므로 assistant 메시지만 있어야 함
    const userMsgs = result!.messages.filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(0);
  });

  // 8. file-history-snapshot, progress, system 레코드 타입은 건너뜀
  it('file-history-snapshot, progress, system 레코드는 건너뛴다', () => {
    const filePath = writeTmpJsonl([
      { type: 'file-history-snapshot', data: 'something' },
      { type: 'progress', value: 50 },
      { type: 'system', info: 'init' },
      makeUser('u1', 'hello'),
      makeAssistant('a1', [{ type: 'text', text: 'hi' }]),
    ]);

    const result = parser.parse(filePath);
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
  });

  // 9. Windows 스타일 \r\n 줄바꿈도 올바르게 파싱
  it('Windows 스타일 \\r\\n 줄바꿈도 올바르게 파싱한다', () => {
    const lines = [
      JSON.stringify(makeUser('u1', 'hello')),
      JSON.stringify(makeAssistant('a1', [{ type: 'text', text: 'hi' }])),
    ].join('\r\n');

    const filePath = writeTmpRaw(lines);
    const result = parser.parse(filePath);
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
  });

  // 10. teammate-message XML은 필터링됨
  it('teammate-message XML이 포함된 user content block은 필터링된다', () => {
    const filePath = writeTmpJsonl([
      makeUser('u1', [
        { type: 'text', text: '<teammate-message from="agent1">do something</teammate-message>' },
      ]),
      makeAssistant('a1', [{ type: 'text', text: 'ok' }]),
    ]);

    const result = parser.parse(filePath);
    expect(result).not.toBeNull();
    // teammate-message 텍스트는 필터링되어 user 메시지가 빈 문자열이므로 messages에 추가 안 됨
    const userMsgs = result!.messages.filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(0);
  });

  // 11. String content인 user 메시지는 그대로 보존됨
  it('string content인 user 메시지는 그대로 보존된다', () => {
    const filePath = writeTmpJsonl([
      makeUser('u1', 'this is a plain string message'),
      makeAssistant('a1', [{ type: 'text', text: 'got it' }]),
    ]);

    const result = parser.parse(filePath);
    expect(result).not.toBeNull();
    const userMsg = result!.messages.find(m => m.role === 'user');
    expect(userMsg!.content).toBe('this is a plain string message');
  });

  // 12. sessionId가 없으면 null
  it('sessionId가 없는 레코드만 있으면 null을 반환한다', () => {
    const filePath = writeTmpJsonl([
      { type: 'file-history-snapshot', data: 'no sessionId here' },
      { type: 'progress', value: 10 },
    ]);

    const result = parser.parse(filePath);
    expect(result).toBeNull();
  });

  // 추가: sessionId와 타임스탬프가 올바르게 설정됨
  it('첫 레코드의 sessionId와 타임스탬프를 올바르게 설정한다', () => {
    const filePath = writeTmpJsonl([
      makeUser('u1', 'first', 'session-abc', '2024-01-01T09:00:00Z'),
      makeAssistant('a1', [{ type: 'text', text: 'reply' }], 'session-abc', '2024-01-01T09:01:00Z'),
    ]);

    const result = parser.parse(filePath);
    expect(result!.sessionId).toBe('session-abc');
    expect(result!.firstTimestamp).toBe('2024-01-01T09:00:00Z');
    expect(result!.lastTimestamp).toBe('2024-01-01T09:01:00Z');
  });

  // 추가: toolUses 목록이 집계됨
  it('toolUses 목록이 중복 없이 집계된다', () => {
    const filePath = writeTmpJsonl([
      makeUser('u1', 'do stuff'),
      makeAssistant('a1', [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/foo' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/bar' } },
      ]),
    ]);

    const result = parser.parse(filePath);
    expect(result).not.toBeNull();
    expect(result!.toolUses).toContain('Read');
    expect(result!.toolUses).toContain('Bash');
    // 중복 없음 확인
    expect(result!.toolUses.filter(t => t === 'Read')).toHaveLength(1);
  });
});
