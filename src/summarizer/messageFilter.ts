import type { ParsedMessage } from '../parser/types';

export interface CompressedConversation {
  text: string;
  originalCount: number;
  keptCount: number;
  fallback: boolean;
}

const USER_FILLER = new Set([
  'ㅇㅇ', 'ㅇ', 'ㄱ', 'ㄱㄱ', 'ㅈㄱ', '넵', '네', '응', '계속', '고',
  'ㄴㄴ', '됐어', '해', '해봐', '해줘', '좋아', '알겠어',
  'ok', 'okay', 'yes', 'no', 'sure', 'thanks', 'ty', 'thx', 'continue',
  'go', 'go ahead', 'got it', 'right', 'yep', 'yup', 'done', 'k', 'kk',
  'next', 'pls', 'please',
]);

const USER_COMMAND = /^(?:커밋해|빌드해봐?|패키징해|설치해|재시작|다시 해봐|해봐)$/;

const USER_NOISE = /^(?:<bash-input>|<bash-stdout>|\[Request interrupted|This session is being continued from a previous conversation)/;

const USER_ERROR = /(?:실행 실패|Command failed|Error:|ENOENT|exit code \d|종료 코드 \d|env: node: No such file)/i;

const ASSISTANT_FILLER = new Set([
  'No response requested.', 'No response requested',
  '빌드 확인.', '빌드 성공.', '설치 완료.', '성공.', '완료.',
  '확인.', '이제 빌드:', '커밋하자.', '커밋 완료.',
  'done.', 'complete.',
]);

const ASSISTANT_NUMBERED_STEP = /^\*\*(?:Step )?\d+/;

const ASSISTANT_ACTION_ENDING = /(?:하자\.|할게\.|한다\.|해보자\.|시작\.|해보자$)$/;

const ASSISTANT_TRANSITION = /^(?:이제|먼저|바로) /;

const ASSISTANT_PROGRESS = /^(?:이제 (?:빌드|커밋|패키징)|빌드해서|빌드 확인|설치 완료|커밋한다|커밋 완료|성공\.|이제 다 파악|충분히 파악|순서대로 구현|바로 구현|소스 코드는 이미)/;

// Strengthened: also protect error stacks, conclusions, stack traces
const ANALYSIS_GUARD = /원인|문제|버그|근본|왜 |인증|에러|실패 원인|해결책|스택|traceback|at \w+\(|Error:|Exception|결론|요약|따라서|그래서/;

function hasCodeBlock(content: string): boolean {
  return /```[\s\S]|^    \S/m.test(content);
}

function isTrivial(msg: ParsedMessage): boolean {
  const trimmed = msg.content.trim();
  if (!trimmed) return true;

  if (msg.role === 'user') {
    if (USER_FILLER.has(trimmed.toLowerCase())) return true;
    if (USER_COMMAND.test(trimmed)) return true;
    if (USER_NOISE.test(trimmed)) return true;
    // USER_ERROR: only treat as noise if it doesn't contain actual analysis content AND no code block
    if (USER_ERROR.test(trimmed) && !ANALYSIS_GUARD.test(trimmed) && !hasCodeBlock(trimmed)) return true;
    // Code blocks are never trivial
    if (hasCodeBlock(trimmed)) return false;
    if (trimmed.length <= 10 && !ANALYSIS_GUARD.test(trimmed) && !/[/.\\]/.test(trimmed)) return true;
  }

  if (msg.role === 'assistant') {
    if (ASSISTANT_FILLER.has(trimmed)) return true;
    if (trimmed.length <= 20 && !/[/.\\`]/.test(trimmed)) return true;
    if (ASSISTANT_NUMBERED_STEP.test(trimmed) && trimmed.length < 100) return true;
    if (ASSISTANT_PROGRESS.test(trimmed) && trimmed.length < 100 && !ANALYSIS_GUARD.test(trimmed)) return true;

    // 행동 선언 + 전환 패턴: 짧고 분석 내용이 없으면 필터
    if (trimmed.length < 80 && !ANALYSIS_GUARD.test(trimmed)) {
      if (ASSISTANT_ACTION_ENDING.test(trimmed)) return true;
      if (ASSISTANT_TRANSITION.test(trimmed)) return true;
    }
  }

  return false;
}

function buildToolDigestLine(toolCalls: NonNullable<ParsedMessage['toolCalls']>): string {
  const MAX_BUDGET = 400;
  const parts: string[] = [];
  let budget = MAX_BUDGET;

  for (const tc of toolCalls) {
    const result = tc.resultDigest ? ` → ${tc.resultDigest}` : '';
    const error = tc.isError ? ' ❌' : '';
    const tag = `[tool:${tc.name} ${tc.inputDigest}${result}${error}]`;
    if (tag.length > budget) break;
    parts.push(tag);
    budget -= tag.length;
  }

  return parts.join(' ');
}

function smartTruncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  // For error/stack-trace content, preserve the tail (relevant frames are often at end)
  const isErrorLike = /Error:|Exception|traceback|at \w+\(/i.test(content);
  if (isErrorLike) {
    const headLen = Math.floor(maxChars * 0.4);
    const tailLen = maxChars - headLen;
    return content.slice(0, headLen) + ' [...] ' + content.slice(-tailLen);
  }
  return content.slice(0, maxChars) + ' [... truncated]';
}

export function compressMessages(
  messages: ParsedMessage[],
  maxCharsPerMessage = 4000,
): CompressedConversation {
  const lines: string[] = [];
  let trivialStreak = 0;
  let keptCount = 0;
  let droppedCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (isTrivial(m)) {
      trivialStreak++;
      droppedCount++;
      continue;
    }

    if (trivialStreak >= 2) {
      lines.push(`[${trivialStreak}개 단순 메시지 생략]`);
    }
    trivialStreak = 0;

    const role = m.role === 'user' ? 'User' : 'Claude';
    const content = smartTruncate(m.content, maxCharsPerMessage);
    lines.push(`[${i}] ${role}: ${content}`);

    // Append tool digest line for assistant messages with tool calls
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const digestLine = buildToolDigestLine(m.toolCalls);
      if (digestLine) lines.push(digestLine);
    }

    keptCount++;
  }

  if (trivialStreak >= 2) {
    lines.push(`[${trivialStreak}개 단순 메시지 생략]`);
  }

  const originalCount = messages.length;

  // Fallback: if filter dropped >70% of messages, include all with only truncation
  if (originalCount > 3 && droppedCount / originalCount > 0.7) {
    const fallbackLines: string[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const role = m.role === 'user' ? 'User' : 'Claude';
      fallbackLines.push(`[${i}] ${role}: ${smartTruncate(m.content, maxCharsPerMessage)}`);
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const digestLine = buildToolDigestLine(m.toolCalls);
        if (digestLine) fallbackLines.push(digestLine);
      }
    }
    return {
      text: fallbackLines.join('\n\n'),
      originalCount,
      keptCount: originalCount,
      fallback: true,
    };
  }

  return {
    text: lines.join('\n\n'),
    originalCount,
    keptCount,
    fallback: false,
  };
}
