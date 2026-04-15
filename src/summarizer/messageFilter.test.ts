import { describe, it, expect } from 'vitest';
import { compressMessages } from './messageFilter';
import type { ParsedMessage } from '../parser/types';

function makeMsg(role: 'user' | 'assistant', content: string, toolCalls?: ParsedMessage['toolCalls']): ParsedMessage {
  return { role, content, toolCalls };
}

describe('compressMessages / isTrivial', () => {
  // 1. USER_FILLER 메시지는 드롭됨
  it('USER_FILLER 메시지는 드롭된다', () => {
    // fallback을 피하기 위해 non-trivial 메시지를 50% 이상 유지 (3 trivial, 4 non-trivial)
    const messages = [
      makeMsg('user', 'ㅇㅇ'),    // trivial
      makeMsg('user', 'ok'),      // trivial
      makeMsg('user', 'continue'), // trivial
      makeMsg('assistant', '이것은 실제로 긴 의미 있는 assistant 메시지입니다. 충분한 길이와 내용을 갖추고 있습니다.'),
      makeMsg('user', '다음 단계는 어떻게 해야 할까요? 좀 더 자세하게 설명해 주세요.'),
      makeMsg('assistant', '두 번째 의미 있는 assistant 메시지입니다. 상세한 기술 내용을 포함합니다.'),
      makeMsg('user', '감사합니다. 이해했습니다. 추가 질문이 있습니다.'),
    ];

    const result = compressMessages(messages);
    // filler 메시지들은 dropped, non-trivial만 kept
    // 3 trivial / 7 total = 42% < 70% threshold이므로 fallback 발동 안 함
    expect(result.fallback).toBe(false);
    // ㅇㅇ, ok, continue는 dropped
    expect(result.text).not.toContain('[0] User: ㅇㅇ');
    expect(result.text).not.toContain('ok');
    expect(result.text).not.toContain('continue');
  });

  // 2. USER_COMMAND 메시지는 드롭됨
  it('USER_COMMAND 메시지는 드롭된다', () => {
    const messages = [
      makeMsg('user', '커밋해'),
      makeMsg('user', '빌드해봐'),
      makeMsg('assistant', '이것은 실제로 긴 의미 있는 assistant 메시지입니다. 충분한 길이와 내용을 갖추고 있습니다.'),
    ];

    const result = compressMessages(messages);
    expect(result.keptCount).toBe(1);
  });

  // 3. 코드 블록이 있는 user 메시지는 드롭되지 않음
  it('코드 블록이 있는 user 메시지는 짧아도 드롭되지 않는다', () => {
    const messages = [
      makeMsg('user', '```bash\nls -la\n```'),
      makeMsg('assistant', '이것은 실제로 긴 의미 있는 assistant 메시지입니다. 충분한 길이와 내용을 갖추고 있습니다.'),
    ];

    const result = compressMessages(messages);
    const text = result.text;
    expect(text).toContain('```bash');
  });

  // 4. ANALYSIS_GUARD: 원인/문제/버그 포함 user 메시지는 드롭되지 않음
  it('ANALYSIS_GUARD 키워드가 있는 user 메시지는 드롭되지 않는다', () => {
    const messages = [
      makeMsg('user', '원인이 뭐야'),
      makeMsg('user', '문제가 있어'),
      makeMsg('user', '버그야'),
      makeMsg('assistant', '이것은 실제로 긴 의미 있는 assistant 메시지입니다. 충분한 길이와 내용을 갖추고 있습니다.'),
    ];

    const result = compressMessages(messages);
    // 세 user 메시지가 모두 kept 되어야 함
    expect(result.keptCount).toBeGreaterThanOrEqual(3);
  });

  // 5. ASSISTANT_FILLER 메시지는 드롭됨
  it('ASSISTANT_FILLER 메시지는 드롭된다', () => {
    const messages = [
      makeMsg('user', '이것은 의미 있는 긴 사용자 질문입니다. 충분한 내용을 포함하고 있습니다.'),
      makeMsg('assistant', 'No response requested.'),
      makeMsg('assistant', '완료.'),
    ];

    const result = compressMessages(messages);
    // filler assistant 메시지들 dropped
    expect(result.keptCount).toBe(1);
  });

  // 6. 짧은 assistant 메시지 (<=20자, 특수문자 없음)는 드롭됨
  it('짧은 assistant 메시지는 드롭된다', () => {
    const messages = [
      makeMsg('user', '이것은 의미 있는 긴 사용자 질문입니다. 충분한 내용을 포함하고 있습니다.'),
      makeMsg('assistant', '알겠습니다'),
    ];

    const result = compressMessages(messages);
    expect(result.keptCount).toBe(1);
  });

  // 7. 긴 의미 있는 assistant 메시지는 유지됨
  it('긴 의미 있는 assistant 메시지는 유지된다', () => {
    const longContent = '이것은 매우 긴 assistant 메시지로 기술적인 분석 내용을 포함하고 있습니다. 여러 줄에 걸쳐 내용이 이어지며 충분히 긴 내용입니다.';
    const messages = [
      makeMsg('user', '이것은 의미 있는 긴 사용자 질문입니다. 충분한 내용을 포함하고 있습니다.'),
      makeMsg('assistant', longContent),
    ];

    const result = compressMessages(messages);
    expect(result.keptCount).toBe(2);
    expect(result.text).toContain(longContent);
  });

  // 8. fallback: >70% trivial이면 fallback 모드
  it('70% 이상 trivial이면 fallback: true를 반환한다', () => {
    const messages = [
      makeMsg('user', 'ㅇㅇ'),       // trivial
      makeMsg('user', 'ok'),         // trivial
      makeMsg('user', 'yes'),        // trivial
      makeMsg('assistant', '이것은 실제로 긴 의미 있는 assistant 메시지입니다. 충분한 길이와 내용을 갖추고 있습니다.'),  // kept
    ];

    const result = compressMessages(messages);
    expect(result.fallback).toBe(true);
    // fallback 모드에서는 모든 메시지가 포함됨
    expect(result.keptCount).toBe(messages.length);
  });

  // 9. trivialStreak >= 2이면 생략 메시지 추가됨
  it('연속 trivial 2개 이상이면 [N개 단순 메시지 생략] 라인이 추가된다', () => {
    // fallback이 발동하지 않도록 충분한 non-trivial 메시지 추가
    const messages = [
      makeMsg('user', '이것은 의미 있는 긴 사용자 질문입니다. 충분한 내용을 포함하고 있습니다.'),
      makeMsg('assistant', '이것은 실제로 긴 의미 있는 assistant 메시지입니다. 충분한 길이와 내용을 갖추고 있습니다.'),
      makeMsg('user', 'ㅇㅇ'),  // trivial streak 1
      makeMsg('user', 'ok'),   // trivial streak 2
      makeMsg('assistant', '이것은 또 다른 의미 있는 assistant 메시지입니다. 충분한 길이를 가지고 있습니다.'),
    ];

    const result = compressMessages(messages);
    expect(result.text).toContain('개 단순 메시지 생략');
  });

  // 10. smartTruncate: error-like content는 head+tail 보존
  it('error-like 내용은 head+tail 방식으로 truncate된다', () => {
    // error 키워드 포함, 매우 긴 내용
    const errorContent = 'Error: something went wrong at line 1\n' + 'x'.repeat(5000) + '\nat someFunction()';
    const messages = [
      makeMsg('assistant', errorContent),
    ];

    const result = compressMessages(messages, 100);
    // [...] 가 포함되고, tail 부분도 보존됨
    expect(result.text).toContain('[...]');
    expect(result.text).toContain('at someFunction()');
  });

  // 11. smartTruncate: 일반 content는 head only + [... truncated]
  it('일반 내용은 head만 남기고 [... truncated]를 추가한다', () => {
    const normalContent = '이것은 일반적인 내용입니다. ' + '가나다라마바사'.repeat(200);
    const messages = [
      makeMsg('assistant', normalContent),
    ];

    const result = compressMessages(messages, 50);
    expect(result.text).toContain('[... truncated]');
    expect(result.text).not.toContain('[...]');
  });

  // 12. toolCalls가 있는 assistant 메시지에 digest line 추가됨
  it('toolCalls가 있는 assistant 메시지에는 digest line이 추가된다', () => {
    const messages = [
      makeMsg('user', '이것은 의미 있는 긴 사용자 질문입니다. 충분한 내용을 포함하고 있습니다.'),
      makeMsg('assistant', '파일을 읽겠습니다. 분석 결과는 다음과 같습니다.', [
        { name: 'Read', inputDigest: 'file=/src/foo.ts', resultDigest: 'contents here' },
      ]),
    ];

    const result = compressMessages(messages);
    expect(result.text).toContain('[tool:Read file=/src/foo.ts → contents here]');
  });

  // 13. 빈 메시지 배열 → 빈 text, 카운트 0
  it('빈 메시지 배열은 빈 text와 카운트 0을 반환한다', () => {
    const result = compressMessages([]);
    expect(result.text).toBe('');
    expect(result.originalCount).toBe(0);
    expect(result.keptCount).toBe(0);
    expect(result.fallback).toBe(false);
  });
});
