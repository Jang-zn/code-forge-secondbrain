import * as path from 'path';
import type { ParsedSession } from '../parser/types';
import type { Logger } from '../ui/Logger';
import type { SummaryResult, Summarizer } from './types';
import { buildSummaryPrompt, parseSummaryTopics } from './summaryUtils';
import { compressMessages } from './messageFilter';

export type { SummaryResult };

export class GeminiSummarizer implements Summarizer {
  private static readonly TIMEOUT_MS = 3 * 60 * 1000; // 3분
  private model: string;

  constructor(
    private apiKey: string,
    model = 'gemini-2.5-flash-lite',
    private logger?: Logger
  ) {
    this.model = model;
  }

  async summarize(session: ParsedSession, previousContext?: string, signal?: AbortSignal): Promise<SummaryResult[]> {
    const { text: conversationText, originalCount, keptCount, fallback } = compressMessages(session.messages);

    if (fallback) {
      const projectName = path.basename(session.projectPath) || 'unknown';
      this.logger?.warn('필터 과도, 원본 fallback 사용', { project: projectName, 원본: originalCount });
    }

    const prompt = buildSummaryPrompt(session, conversationText, previousContext);

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(this.apiKey);
    const geminiModel = genAI.getGenerativeModel({
      model: this.model,
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });

    const projectName = path.basename(session.projectPath) || 'unknown';
    const tracker = this.logger?.apiStart(this.model, `${projectName} ${keptCount}/${originalCount}개 메시지 요약`);
    let text: string;
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Gemini API 타임아웃 (${GeminiSummarizer.TIMEOUT_MS / 1000}초 초과)`)),
          GeminiSummarizer.TIMEOUT_MS
        )
      );

      let abortReject: ((err: Error) => void) | undefined;
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            abortReject = reject;
            signal.addEventListener('abort', () => reject(new Error('취소됨')), { once: true });
          })
        : null;

      const result = await Promise.race([
        geminiModel.generateContent(prompt),
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ]);
      void abortReject; // suppress unused warning
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
