import { describe, it, expect } from 'vitest';
import { buildSummaryPrompt, parseSummaryTopics, buildPreviousContextSection } from './summaryUtils';
import type { ParsedSession } from '../parser/types';

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: 'test-session',
    projectPath: '/test/project',
    gitBranch: 'main',
    slug: undefined,
    firstTimestamp: '2024-01-01T10:00:00Z',
    lastTimestamp: '2024-01-01T11:00:00Z',
    messages: [],
    toolUses: ['Read', 'Bash'],
    filePath: '/tmp/test.jsonl',
    mtime: 1000000,
    ...overrides,
  };
}

// ─── parseSummaryTopics ───────────────────────────────────────────────────────

describe('parseSummaryTopics', () => {
  const allIndices = [0, 1, 2, 3];

  // 1. 유효한 JSON with topics 배열
  it('유효한 JSON에서 topics 배열을 파싱한다', () => {
    const raw = JSON.stringify({
      topics: [
        {
          title: '테스트 주제',
          summary: '테스트 요약',
          keyTopics: ['TypeScript', 'Node.js'],
          decisions: ['결정 1'],
          codeChanges: ['src/foo.ts: 수정'],
          tags: ['log'],
          messageIndices: [0, 1],
          incomplete: false,
          investigation: '조사 내용',
          decisionRationale: '결정 근거',
          insights: ['인사이트 1'],
        },
      ],
    });

    const results = parseSummaryTopics(raw, allIndices);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('테스트 주제');
    expect(results[0].summary).toBe('테스트 요약');
    expect(results[0].keyTopics).toEqual(['TypeScript', 'Node.js']);
    expect(results[0].messageIndices).toEqual([0, 1]);
  });

  // 2. ```json fence로 감싸진 JSON도 파싱됨
  it('```json 펜스로 감싸진 JSON도 파싱한다', () => {
    const raw = '```json\n' + JSON.stringify({
      topics: [{ title: 'Test', summary: 's', keyTopics: [], decisions: [], codeChanges: [], tags: ['log'], messageIndices: [0], investigation: '', decisionRationale: '', insights: [] }],
    }) + '\n```';

    const results = parseSummaryTopics(raw, allIndices);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Test');
  });

  // 3. 잘못된 JSON → 에러 throw (메시지에 '요약 JSON 파싱 실패' 포함)
  it('잘못된 JSON은 요약 JSON 파싱 실패 에러를 던진다', () => {
    expect(() => parseSummaryTopics('not json at all', allIndices)).toThrow('요약 JSON 파싱 실패');
  });

  // 4. topics 배열이 비어있으면 빈 배열 반환
  it('topics 배열이 비어있으면 빈 배열을 반환한다', () => {
    const raw = JSON.stringify({ topics: [] });
    const results = parseSummaryTopics(raw, allIndices);
    expect(results).toHaveLength(0);
  });

  // 5. optional 필드 누락 시 기본값 적용
  it('optional 필드가 누락되면 기본값이 적용된다', () => {
    const raw = JSON.stringify({
      topics: [{ title: 'minimal' }],
    });

    const results = parseSummaryTopics(raw, allIndices);
    expect(results[0].summary).toBe('');
    expect(results[0].keyTopics).toEqual([]);
    expect(results[0].decisions).toEqual([]);
    expect(results[0].codeChanges).toEqual([]);
    expect(results[0].tags).toEqual([]);
    expect(results[0].investigation).toBe('');
    expect(results[0].decisionRationale).toBe('');
    expect(results[0].insights).toEqual([]);
    expect(results[0].incomplete).toBe(false);
  });

  // 6. codeChanges에 object 항목은 JSON.stringify로 변환됨
  it('codeChanges에 object 항목은 JSON.stringify된다', () => {
    const raw = JSON.stringify({
      topics: [{
        title: 'test',
        codeChanges: [{ file: 'foo.ts', change: '수정' }, 'plain string'],
      }],
    });

    const results = parseSummaryTopics(raw, allIndices);
    expect(typeof results[0].codeChanges[0]).toBe('string');
    expect(results[0].codeChanges[0]).toContain('foo.ts');
    expect(results[0].codeChanges[1]).toBe('plain string');
  });

  // 7. incomplete 필드: true/false/undefined 처리
  it('incomplete: true이면 true, 그 외는 false를 반환한다', () => {
    const rawTrue = JSON.stringify({ topics: [{ title: 'a', incomplete: true }] });
    const rawFalse = JSON.stringify({ topics: [{ title: 'b', incomplete: false }] });
    const rawUndef = JSON.stringify({ topics: [{ title: 'c' }] });

    expect(parseSummaryTopics(rawTrue, allIndices)[0].incomplete).toBe(true);
    expect(parseSummaryTopics(rawFalse, allIndices)[0].incomplete).toBe(false);
    expect(parseSummaryTopics(rawUndef, allIndices)[0].incomplete).toBe(false);
  });

  // 8. messageIndices가 비어있으면 allIndices로 폴백
  it('messageIndices가 비어있으면 allIndices를 사용한다', () => {
    const raw = JSON.stringify({
      topics: [{ title: 'test', messageIndices: [] }],
    });

    const results = parseSummaryTopics(raw, allIndices);
    expect(results[0].messageIndices).toEqual(allIndices);
  });

  // 9. 주변 텍스트 사이에 JSON이 있으면 추출함
  it('주변 텍스트 사이에 JSON이 있으면 추출하여 파싱한다', () => {
    const inner = JSON.stringify({ topics: [{ title: 'extracted' }] });
    const raw = `여기에 텍스트가 있고\n${inner}\n뒤에도 텍스트가 있습니다.`;

    const results = parseSummaryTopics(raw, allIndices);
    expect(results[0].title).toBe('extracted');
  });

  // logger 있을 때 invalid JSON이면 stats.apiInvalidated 증가
  it('invalid JSON이면 logger.stats.apiInvalidated가 증가한다', () => {
    const fakeLogger = { stats: { apiInvalidated: 0 } } as any;
    expect(() => parseSummaryTopics('invalid', allIndices, fakeLogger)).toThrow();
    expect(fakeLogger.stats.apiInvalidated).toBe(1);
  });
});

// ─── buildPreviousContextSection ─────────────────────────────────────────────

describe('buildPreviousContextSection', () => {
  const sampleNote = `# Claude 대화

## Summary
이전 대화의 요약 내용입니다.

## Decisions
- 결정 1
- 결정 2

## Insights
- 인사이트 1

## Full Conversation
[전체 대화 내용...]`;

  // 1. ## Summary 섹션 추출
  it('## Summary 섹션을 추출한다', () => {
    const result = buildPreviousContextSection([sampleNote]);
    expect(result).toContain('## Summary');
    expect(result).toContain('이전 대화의 요약 내용입니다.');
  });

  // 2. ## Decisions 섹션 추출
  it('## Decisions 섹션을 추출한다', () => {
    const result = buildPreviousContextSection([sampleNote]);
    expect(result).toContain('## Decisions');
    expect(result).toContain('결정 1');
  });

  // 3. ## Insights 섹션 추출
  it('## Insights 섹션을 추출한다', () => {
    const result = buildPreviousContextSection([sampleNote]);
    expect(result).toContain('## Insights');
    expect(result).toContain('인사이트 1');
  });

  // 4. 없는 섹션이 있어도 에러 없음
  it('없는 섹션이 있어도 에러 없이 동작한다', () => {
    const noteWithoutInsights = `# Claude 대화\n\n## Summary\n요약입니다.\n`;
    expect(() => buildPreviousContextSection([noteWithoutInsights])).not.toThrow();
    const result = buildPreviousContextSection([noteWithoutInsights]);
    expect(result).toContain('## Summary');
    expect(result).not.toContain('## Insights');
  });

  // 5. maxBytes 초과 시 '[...이전 컨텍스트 생략]'으로 잘림
  it('maxBytes 초과 시 [...]이전 컨텍스트 생략으로 잘린다', () => {
    const bigNote = `## Summary\n${'이것은 매우 긴 내용입니다. '.repeat(200)}\n## Decisions\n- d1`;
    const result = buildPreviousContextSection([bigNote], 100);
    expect(result).toContain('[...이전 컨텍스트 생략]');
    // 구현상 slice(0, maxBytes) + suffix 이므로 maxBytes + suffix 길이보다 클 수 없음
    const suffix = '\n[...이전 컨텍스트 생략]';
    expect(result.length).toBeLessThanOrEqual(100 + suffix.length);
  });

  // 6. 여러 노트는 '---' separator로 합쳐짐
  it('여러 노트는 --- separator로 합쳐진다', () => {
    const note1 = `## Summary\n요약 1`;
    const note2 = `## Summary\n요약 2`;
    const result = buildPreviousContextSection([note1, note2]);
    expect(result).toContain('---');
    expect(result).toContain('요약 1');
    expect(result).toContain('요약 2');
  });

  // 7. 빈 배열 → 빈 문자열
  it('빈 배열은 빈 문자열을 반환한다', () => {
    const result = buildPreviousContextSection([]);
    expect(result).toBe('');
  });
});

// ─── buildSummaryPrompt ───────────────────────────────────────────────────────

describe('buildSummaryPrompt', () => {
  // 1. previousContext 없으면 '=======' 섹션 없음
  it('previousContext가 없으면 구분선 섹션이 없다', () => {
    const session = makeSession();
    const prompt = buildSummaryPrompt(session, '대화 내용');
    expect(prompt).not.toContain('========');
  });

  // 2. previousContext 있으면 '=======' 섹션 포함
  it('previousContext가 있으면 구분선 섹션이 포함된다', () => {
    const session = makeSession();
    const prompt = buildSummaryPrompt(session, '대화 내용', '이전 요약 내용');
    expect(prompt).toContain('========');
    expect(prompt).toContain('이전 요약 내용');
  });

  // 3. toolUses가 비어있으면 '없음'
  it('toolUses가 비어있으면 없음이 표시된다', () => {
    const session = makeSession({ toolUses: [] });
    const prompt = buildSummaryPrompt(session, '대화 내용');
    expect(prompt).toContain('없음');
  });

  // 4. gitBranch가 undefined면 'unknown' 표시
  it('gitBranch가 undefined이면 unknown이 표시된다', () => {
    const session = makeSession({ gitBranch: undefined });
    const prompt = buildSummaryPrompt(session, '대화 내용');
    expect(prompt).toContain('unknown');
  });

  // 5. session 정보가 prompt에 포함됨
  it('session.projectPath가 prompt에 포함된다', () => {
    const session = makeSession({ projectPath: '/my/special/project' });
    const prompt = buildSummaryPrompt(session, '대화');
    expect(prompt).toContain('/my/special/project');
  });

  // 6. conversationText가 prompt에 포함됨
  it('conversationText가 prompt에 포함된다', () => {
    const session = makeSession();
    const conversationText = '특별한 대화 내용이 여기 있습니다.';
    const prompt = buildSummaryPrompt(session, conversationText);
    expect(prompt).toContain(conversationText);
  });
});
