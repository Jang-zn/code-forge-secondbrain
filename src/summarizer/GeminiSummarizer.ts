import type { ParsedSession } from '../parser/types';

export interface SummaryResult {
  title: string;
  summary: string;
  keyTopics: string[];
  decisions: string[];
  codeChanges: string[];
  tags: string[];
}

export class GeminiSummarizer {
  private model: string;

  constructor(
    private apiKey: string,
    model = 'gemini-2.5-flash-lite'
  ) {
    this.model = model;
  }

  async summarize(session: ParsedSession): Promise<SummaryResult[]> {
    const conversationText = session.messages
      .map(m => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content}`)
      .join('\n\n');

    const prompt = `다음은 Claude Code AI와의 대화입니다. 이 대화를 분석하여 Obsidian 노트용 구조화된 요약을 JSON 형식으로 반환하세요.

프로젝트: ${session.projectPath}
Git 브랜치: ${session.gitBranch ?? 'unknown'}
사용한 도구: ${session.toolUses.join(', ') || '없음'}

대화 내용:
${conversationText}

다음 JSON 스키마로 응답하세요 (다른 텍스트 없이 JSON만):
{
  "topics": [
    {
      "title": "대화의 핵심 주제를 나타내는 짧고 명확한 제목 (한국어 또는 영어, 50자 이내)",
      "summary": "이 주제에서 무엇을 했는지 10-15문장으로 요약(한글로 적어주세요)",
      "keyTopics": ["주요 기술/개념 목록 (최대 8개, 중복 없이 적어주세요, 한글로 적어주세요)"],
      "decisions": ["이 주제에서 내린 결정 사항들 (한글로 적어주세요)"],
      "codeChanges": ["수정/생성된 파일 및 변경 내용 (한글로 적어주세요)"],
      "tags": ["분류 태그 (기술명, 작업 유형 등, 최대 5개, 중복 없이 적어주세요, 한글로 적어주세요)"]
    }
  ]
}
주제가 1개면 배열 요소 1개, 명확히 다른 주제가 2-3개 있으면 분리해서 각각 배열 요소로 만들어주세요.`;

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
      return topics.map(t => ({
        title: t.title ?? 'Claude 대화',
        summary: t.summary ?? '',
        keyTopics: Array.isArray(t.keyTopics) ? t.keyTopics : [],
        decisions: Array.isArray(t.decisions) ? t.decisions : [],
        codeChanges: Array.isArray(t.codeChanges) ? t.codeChanges : [],
        tags: Array.isArray(t.tags) ? t.tags : [],
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
      }];
    }
  }
}
