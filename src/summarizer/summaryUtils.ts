import type { ParsedSession } from '../parser/types';
import type { Logger } from '../ui/Logger';
import type { SummaryResult } from './types';

export function buildSummaryPrompt(session: ParsedSession, conversationText: string, previousContext?: string): string {
  return `다음은 Claude Code AI와의 대화입니다. 이 대화를 분석하여 Obsidian 노트용 구조화된 요약을 JSON 형식으로 반환하세요.

핵심 원칙: '무엇을 했는가'뿐 아니라 '왜 그렇게 했는가', '다른 방법은 왜 안 되는가', '이 경험에서 무엇을 배웠는가'를 포착하세요. 나중에 같은 문제를 만났을 때 이 노트만 읽고 의사결정을 재현할 수 있어야 합니다.
코드 변경이 없는 대화(전략 수립, 설계 논의, 학습자료 작성, SEO, 아키텍처 검토 등)에서도 동일한 깊이로 기술 내용을 기록하세요. '~을 했다'가 아니라 '어떤 원리/전략/패턴을 적용했고 왜 효과적인가'를 기록하세요.

프로젝트: ${session.projectPath}
Git 브랜치: ${session.gitBranch ?? 'unknown'}
사용한 도구: ${session.toolUses.join(', ') || '없음'}
${previousContext ? `
========================================
[맥락 참고용 — 문서화 대상 아님]
이전에 처리된 대화 요약입니다. 흐름 파악에만 사용하고, 이 내용을 새 노트로 만들지 마세요.

${previousContext}
========================================
` : ''}
[메시지 형식 안내]
대화 내 [tool:ToolName 속성...] 태그는 Claude가 사용한 도구와 그 결과를 요약한 메타데이터입니다.
예: [tool:Edit file=src/foo.ts → ok], [tool:Bash cmd=npm run build → exit 0], [tool:Edit file=src/bar.ts → 에러 내용 ❌]
codeChanges와 investigation 작성 시 이 태그의 파일 경로와 결과를 참고하세요.

[문서화 대상 — 아래 내용만 노트로 만드세요]
새로운 대화 내용:
${conversationText}

**언어 규칙: 대화가 어떤 언어(영어 포함)로 되어 있어도 summary, investigation, decisionRationale, decisions, codeChanges, insights 필드는 반드시 한국어로 작성하세요. keyTopics만 영문 기술명을 사용합니다.**

중요 지시사항:
- 문서화 기준: 아래 사이클이 완성된 대화만 노트로 만드세요.
  • 일반: 사용자의 문제 제기 → 해결방안 제시 및 구체화/빌드업 → 해결방안 실행
  • 코드 품질 개선(리팩토링, 단순화, 정리 등): 문제(현재 코드의 문제점) → 해결방안(개선 방향 구체화) → 적용(실제 변경). 이 세 단계가 반복적으로 이어지더라도 하나의 문서로 묶으세요.
  문제를 확인하기 위한 단순 정보 수집(코드베이스 읽기, 파일 탐색, 패턴 분석, 로그 확인 등)은 그 자체로는 문서화 대상이 아닙니다. 사이클의 "실행" 단계까지 완료된 경우에만 문서화하세요.
- 대화가 문서화할 가치가 없는 경우 topics 배열을 비워서 반환하세요 ({"topics": []}). 예: 종료 명령, 단순 확인 응답, 에이전트 내부 통신, 짧은 상태 확인, 단순 코드/파일 탐색 및 읽기만 한 경우.
- 대화에 등장하는 '팀', 'team', 'teammate'는 Claude Code의 Teams 기능(자동 생성된 서브에이전트)을 의미합니다. 실제 사람 팀원이나 팀 리더에게 보고하거나 소통하는 것이 아닙니다. 요약에서 '팀에 보고', '팀원과 협의', '팀 리드에게 전달' 등의 표현을 사용하지 마세요.
- **incomplete 판단 기준 — 반드시 아래를 확인하세요:**
  Claude의 응답이 실제 결과(분석 내용, 코드 변경, 수치, 구체적 발견 등)를 포함하지 않고 의도 선언만 있는 경우 반드시 \`"incomplete": true\`로 설정하세요.
  의도 선언의 예: "~하겠습니다", "분석을 시작하겠습니다", "파일을 찾겠습니다", "I'll analyze", "I'll wait", "Let me start", "대기하겠습니다" 등.
  또한 User 메시지가 \`<teammate-message\`로 시작하는 XML 블록이고 Claude가 대기·준비 선언만 한 경우는 팀 에이전트 내부 초기화 메시지이므로 \`{"topics": []}\`를 반환하세요.
  사이클 완성 판단 시 User의 task description을 "완료된 작업"으로 오해하지 마세요 — Claude가 실제로 그 결과를 제시했는지를 기준으로 판단하세요.
- **서술형 필드 작성 규칙 (summary, investigation, decisionRationale):**
  문장마다 두 글자 이스케이프 시퀀스 \\n을 문자열 값 안에 삽입하세요. 관련된 2-3문장은 같은 단락으로 묶고, 맥락이 전환될 때 빈 줄 \\n\\n으로 단락을 구분하세요. JSON 문자열 안에 실제 개행 문자(raw newline)를 직접 쓰면 파싱이 깨집니다. 벽처럼 이어붙인 텍스트는 금지입니다.

반드시 단일 JSON 객체만 출력하세요. 다른 텍스트 없이 JSON만 출력하세요.
다음 JSON 스키마로 응답하세요:
{
  "topics": [
    {
      "title": "대화의 핵심 주제를 나타내는 짧고 명확한 제목 (한국어 또는 영어, 50자 이내)",
      "summary": "이 주제에서 무엇을, 왜, 어떤 방식으로 했는지 5-10문장으로 요약 (한글로). 접근 방식의 선택 이유를 포함하세요. 코드 변경이 아닌 지식/전략 논의의 경우, 논의된 핵심 기술 내용(구체적 전략, 원리, 구조, 수치 등)을 반드시 포함하세요. '~를 만들었다/논의했다'로 끝내지 말고 실제 내용을 서술하세요.",
      "investigation": "기술적 조사 과정 (한글로). 어떤 가설을 세웠고, 무엇을 확인했으며, 근본 원인이 무엇이었는지. 단순 버그 수정이라면 원인과 증상의 관계를 명확히. 탐색/분석만 한 경우에도 발견한 내용을 기록. 조사 과정이 없으면 빈 문자열.",
      "decisionRationale": "핵심 결정의 근거 (한글로). 어떤 대안이 있었고, 각각의 장단점은 무엇이었으며, 왜 최종 방안을 선택했는지. 대화에서 암묵적으로 드러난 맥락도 명시적으로 포함. 기술적 결정이 없으면 빈 문자열.",
      "keyTopics": ["vault 노트 링크용 구체적 기술/개념명, 최대 8개 (영문 기술명 그대로 사용)"],
      "decisions": ["이 주제에서 내린 결정 사항들을 상세하게 (한글로)"],
      "codeChanges": ["수정/생성된 파일 및 변경 내용 요약 — 반드시 문자열로만, 예: 'src/foo.ts: 버그 수정' (한글로)"],
      "insights": ["이 작업에서 얻은 재사용 가능한 기술 지식/교훈 (한글로). 각 인사이트는 '왜/언제/어떻게'를 포함한 구체적 문장이어야 합니다. 나쁜 예: 'SEO 최적화를 했다', '학습자료를 만들었다' (행동 서술일 뿐 지식이 아님). 좋은 예: 'Next.js에서 generateMetadata로 동적 OG 이미지를 설정하면 SNS 공유 시 CTR이 올라간다', 'chokidar의 awaitWriteFinish 없이 쓰면 부분 기록된 파일을 읽게 된다', 'Bloom 택소노미에서 Create 단계 학습자료는 빈칸 채우기보다 프로젝트 기반 과제가 효과적이다'. 코드 변경이 없는 지식 대화에서도 논의된 원리·패턴·전략을 반드시 추출하세요. 최소 1개 이상 작성하세요."],
      "tags": ["첫 번째 태그는 반드시 log 또는 tech-insight 중 하나. log: 단순 작업 기록(설정, 설치, 간단한 수정). tech-insight: 기술적 깊이가 있는 작업(아키텍처 결정, 복잡한 디버깅, 설계 검토). 이후 작업 유형 태그 추가, 최대 5개"],
      "messageIndices": [0, 1, 2],
      "incomplete": false
    }
  ]
}
messageIndices는 이 주제에 해당하는 메시지의 인덱스 번호 배열입니다. 대화를 여러 주제로 분리할 경우 각 주제에 관련된 메시지 번호([0], [1], ... 앞에 붙은 숫자)를 할당하세요. 주제가 1개인 경우 모든 인덱스를 포함하세요.
작업 단위 맥락으로 최대 5개 이내로 나누세요. 관련 작업은 하나로 묶고, 사소한 확인/중간 대화는 별도 주제로 분리하지 마세요. 대부분의 대화는 1-2개 주제면 충분합니다.
- 검토(분석/리뷰) 후 구현(액션)으로 이어지는 흐름은 하나의 작업 단위로 간주하세요. 대화 전체가 하나의 목표를 위한 것이라면 반드시 1개 topic으로 반환하세요.
- 대화가 검토/분석 단계에서 끝났고 실제 결론·구현·결정이 없다면 해당 topic에 \`"incomplete": true\`를 설정하세요. 이 경우 노트가 생성되지 않고 다음 세션과 합쳐서 처리됩니다.`;
}

export function parseSummaryTopics(rawText: string, allIndices: number[], logger?: Logger): SummaryResult[] {
  // Strip markdown fences
  let jsonText = rawText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  // Fallback: extract first {...} block if text doesn't start with {
  if (!jsonText.startsWith('{')) {
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start >= 0 && end > start) {
      jsonText = jsonText.slice(start, end + 1);
    }
  }

  let topics: SummaryResult[];
  try {
    const parsed = JSON.parse(jsonText) as { topics: SummaryResult[] };
    topics = Array.isArray(parsed.topics) ? parsed.topics : [];
  } catch (firstErr) {
    // 1차 실패: sanitize 후 재시도
    try {
      const sanitized = sanitizeJsonText(jsonText);
      const parsed = JSON.parse(sanitized) as { topics: SummaryResult[] };
      topics = Array.isArray(parsed.topics) ? parsed.topics : [];
    } catch {
      if (logger) {
        logger.stats.apiInvalidated++;
      }
      throw new Error(`요약 JSON 파싱 실패: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}`);
    }
  }

  return topics.map(t => ({
    title: t.title ?? 'Claude 대화',
    summary: t.summary ?? '',
    keyTopics: Array.isArray(t.keyTopics) ? t.keyTopics : [],
    decisions: Array.isArray(t.decisions) ? t.decisions : [],
    codeChanges: Array.isArray(t.codeChanges)
      ? t.codeChanges.map((c: unknown) => typeof c === 'string' ? c : JSON.stringify(c))
      : [],
    tags: Array.isArray(t.tags) ? t.tags : [],
    messageIndices: Array.isArray(t.messageIndices) && t.messageIndices.length > 0
      ? t.messageIndices
      : allIndices,
    incomplete: t.incomplete === true,
    investigation: typeof t.investigation === 'string' ? t.investigation : '',
    decisionRationale: typeof t.decisionRationale === 'string' ? t.decisionRationale : '',
    insights: Array.isArray(t.insights) ? t.insights : [],
  }));
}

function sanitizeJsonText(text: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  for (const ch of text) {
    if (escape) { out += ch; escape = false; continue; }
    if (ch === '\\') { out += ch; escape = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Extract Summary, Decisions, and Insights sections from previous note files.
 * Used to build previousContext without feeding the full note (including Full Conversation).
 * Applies a 2KB cap to prevent token bloat.
 */
export function buildPreviousContextSection(noteContents: string[], maxBytes = 2048): string {
  const RELEVANT = ['## Summary', '## Decisions', '## Insights'];
  const parts: string[] = [];

  for (const content of noteContents) {
    const sections: string[] = [];
    for (const heading of RELEVANT) {
      // Match heading and everything until the next ## heading or end of string
      const regex = new RegExp(`${heading}\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
      const match = content.match(regex);
      if (match?.[1]?.trim()) {
        sections.push(`${heading}\n${match[1].trim()}`);
      }
    }
    if (sections.length > 0) {
      parts.push(sections.join('\n\n'));
    }
  }

  let combined = parts.join('\n\n---\n\n');
  if (combined.length > maxBytes) {
    combined = combined.slice(0, maxBytes) + '\n[...이전 컨텍스트 생략]';
  }
  return combined;
}
