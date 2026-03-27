import type { ParsedSession } from '../parser/types';

export interface SummaryResult {
  title: string;
  summary: string;
  keyTopics: string[];
  decisions: string[];
  codeChanges: string[];
  tags: string[];
  messageIndices: number[];
  incomplete?: boolean;
}

export class GeminiSummarizer {
  private model: string;

  constructor(
    private apiKey: string,
    model = 'gemini-2.5-flash-lite'
  ) {
    this.model = model;
  }

  async summarize(session: ParsedSession, previousContext?: string): Promise<SummaryResult[]> {
    const conversationText = session.messages
      .map((m, i) => `[${i}] ${m.role === 'user' ? 'User' : 'Claude'}: ${m.content}`)
      .join('\n\n');

    const prompt = `다음은 Claude Code AI와의 대화입니다. 이 대화를 분석하여 Obsidian 노트용 구조화된 요약을 JSON 형식으로 반환하세요.

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
[문서화 대상 — 아래 내용만 노트로 만드세요]
새로운 대화 내용:
${conversationText}

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

다음 JSON 스키마로 응답하세요 (다른 텍스트 없이 JSON만):
{
  "topics": [
    {
      "title": "대화의 핵심 주제를 나타내는 짧고 명확한 제목 (한국어 또는 영어, 50자 이내)",
      "summary": "이 주제에서 무엇을 했는지 5-10문장으로 요약 (한글로). 2-3문장마다 빈 줄(\\n\\n)로 단락을 구분하세요.",
      "keyTopics": ["vault 노트 링크용 구체적 기술/개념명, 최대 8개 (영문 기술명 그대로 사용)"],
      "decisions": ["이 주제에서 내린 결정 사항들을 상세하게 (한글로)"],
      "codeChanges": ["수정/생성된 파일 및 변경 내용 요약 — 반드시 문자열로만, 예: 'src/foo.ts: 버그 수정' (한글로)"],
      "tags": ["작업 유형 분류 태그, 최대 5개 (예: 버그수정, 리팩토링, 설정, 기능추가, 학습자료)"],
      "messageIndices": [0, 1, 2],
      "incomplete": false
    }
  ]
}
messageIndices는 이 주제에 해당하는 메시지의 인덱스 번호 배열입니다. 대화를 여러 주제로 분리할 경우 각 주제에 관련된 메시지 번호([0], [1], ... 앞에 붙은 숫자)를 할당하세요. 주제가 1개인 경우 모든 인덱스를 포함하세요.
작업 단위 맥락으로 최대 5개 이내로 나누세요. 관련 작업은 하나로 묶고, 사소한 확인/중간 대화는 별도 주제로 분리하지 마세요. 대부분의 대화는 1-2개 주제면 충분합니다.
- 검토(분석/리뷰) 후 구현(액션)으로 이어지는 흐름은 하나의 작업 단위로 간주하세요. 대화 전체가 하나의 목표를 위한 것이라면 반드시 1개 topic으로 반환하세요.
- 대화가 검토/분석 단계에서 끝났고 실제 결론·구현·결정이 없다면 해당 topic에 \`"incomplete": true\`를 설정하세요. 이 경우 노트가 생성되지 않고 다음 세션과 합쳐서 처리됩니다.`;

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(this.apiKey);
    const geminiModel = genAI.getGenerativeModel({ model: this.model });

    const result = await geminiModel.generateContent(prompt);
    const text = result.response.text().trim();

    // Strip markdown code fences if present
    const jsonText = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

    try {
      const parsed = JSON.parse(jsonText) as { topics: SummaryResult[] };
      const topics = Array.isArray(parsed.topics) ? parsed.topics : [];
      const allIndices = session.messages.map((_, i) => i);
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
      }));
    } catch (e) {
      throw new Error(`요약 JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
