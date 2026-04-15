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
  investigation: string;
  decisionRationale: string;
  insights: string[];
}

export interface Summarizer {
  summarize(session: ParsedSession, previousContext?: string, signal?: AbortSignal): Promise<SummaryResult[]>;
}
