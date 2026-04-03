import * as path from 'path';
import type { ParsedSession } from '../parser/types';
import type { Logger } from '../ui/Logger';
import type { SummaryResult, Summarizer } from './types';
import { buildSummaryPrompt, parseSummaryTopics } from './summaryUtils';
import { compressMessages } from './messageFilter';

export type { SummaryResult };

export class GeminiSummarizer implements Summarizer {
  private model: string;

  constructor(
    private apiKey: string,
    model = 'gemini-2.5-flash-lite',
    private logger?: Logger
  ) {
    this.model = model;
  }

  async summarize(session: ParsedSession, previousContext?: string): Promise<SummaryResult[]> {
    const { text: conversationText, originalCount, keptCount } = compressMessages(session.messages);

    const prompt = buildSummaryPrompt(session, conversationText, previousContext);

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(this.apiKey);
    const geminiModel = genAI.getGenerativeModel({ model: this.model });

    const projectName = path.basename(session.projectPath) || 'unknown';
    const tracker = this.logger?.apiStart(this.model, `${projectName} ${keptCount}/${originalCount}개 메시지 요약`);
    let text: string;
    try {
      const result = await geminiModel.generateContent(prompt);
      text = result.response.text().trim();
    } catch (err) {
      tracker?.fail(err);
      throw err;
    }

    let topics: SummaryResult[];
    try {
      const allIndices = session.messages.map((_, i) => i);
      topics = parseSummaryTopics(text, allIndices, this.logger);
    } catch (e) {
      tracker?.fail(e);
      throw e;
    }

    const incompleteCount = topics.filter(t => t.incomplete === true).length;
    tracker?.end(`${topics.length}개 토픽 (미완료 ${incompleteCount})`);
    return topics;
  }
}
