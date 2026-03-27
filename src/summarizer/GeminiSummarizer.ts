import type { ParsedSession } from '../parser/types';

export interface SummaryResult {
  title: string;
  summary: string;
  keyTopics: string[];
  decisions: string[];
  codeChanges: string[];
  tags: string[];
  messageIndices: number[];
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

다음 JSON 스키마로 응답하세요 (다른 텍스트 없이 JSON만):
{
  "topics": [
    {
      "title": "대화의 핵심 주제를 나타내는 짧고 명확한 제목 (한국어 또는 영어, 50자 이내)",
      "summary": "이 주제에서 무엇을 했는지 5-10문장으로 요약 (한글로)",
      "keyTopics": ["vault 노트 링크용 구체적 기술/개념명, 최대 8개 (영문 기술명 그대로 사용)"],
      "decisions": ["이 주제에서 내린 결정 사항들을 상세하게 (한글로)"],
      "codeChanges": ["수정/생성된 파일 및 변경 내용 요약 — 반드시 문자열로만, 예: 'src/foo.ts: 버그 수정' (한글로)"],
      "tags": ["작업 유형 분류 태그, 최대 5개 (예: 버그수정, 리팩토링, 설정, 기능추가, 학습자료)"],
      "messageIndices": [0, 1, 2]
    }
  ]
}
messageIndices는 이 주제에 해당하는 메시지의 인덱스 번호 배열입니다. 대화를 여러 주제로 분리할 경우 각 주제에 관련된 메시지 번호([0], [1], ... 앞에 붙은 숫자)를 할당하세요. 주제가 1개인 경우 모든 인덱스를 포함하세요.
작업 단위 맥락으로 최대 5개 이내로 나누세요. 관련 작업은 하나로 묶고, 사소한 확인/중간 대화는 별도 주제로 분리하지 마세요. 대부분의 대화는 1-2개 주제면 충분합니다.`;

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
      }));
    } catch {
      // Fallback if JSON parsing fails
      return [{
        title: `Claude 대화 ${session.sessionId.slice(0, 8)}`,
        summary: '요약 생성 실패',
        keyTopics: session.toolUses.slice(0, 5),
        decisions: [],
        codeChanges: [],
        tags: ['claude'],
        messageIndices: session.messages.map((_, i) => i),
      }];
    }
  }
}
