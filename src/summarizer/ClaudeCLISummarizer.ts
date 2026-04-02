import * as path from 'path';
import { spawn } from 'child_process';
import type { ParsedSession } from '../parser/types';
import type { Logger } from '../ui/Logger';
import type { SummaryResult, Summarizer } from './types';
import { buildSummaryPrompt, parseSummaryTopics } from './summaryUtils';
import { resolveExecutor } from '../spawnHelper';

export class ClaudeCLISummarizer implements Summarizer {
  constructor(
    private binary = 'claude',
    private model = 'sonnet',
    private logger?: Logger
  ) {}

  async summarize(session: ParsedSession, previousContext?: string): Promise<SummaryResult[]> {
    const conversationText = session.messages
      .map((m, i) => `[${i}] ${m.role === 'user' ? 'User' : 'Claude'}: ${m.content}`)
      .join('\n\n');

    const prompt = buildSummaryPrompt(session, conversationText, previousContext);

    const projectName = path.basename(session.projectPath) || 'unknown';
    const tracker = this.logger?.apiStart(this.model, `${projectName} ${session.messages.length}개 메시지 요약`);

    let rawText: string;
    try {
      rawText = await this.spawnClaude(prompt);
    } catch (err) {
      tracker?.fail(err);
      throw err;
    }

    // --output-format json wraps the result: { type, subtype, result, ... }
    let textToParse: string;
    try {
      const outer = JSON.parse(rawText) as { result?: string; content?: string };
      textToParse = (outer.result ?? outer.content ?? rawText).trim();
    } catch {
      textToParse = rawText.trim();
    }

    let topics: SummaryResult[];
    try {
      const allIndices = session.messages.map((_, i) => i);
      topics = parseSummaryTopics(textToParse, allIndices, this.logger);
    } catch (e) {
      tracker?.fail(e);
      throw e;
    }

    const incompleteCount = topics.filter(t => t.incomplete === true).length;
    tracker?.end(`${topics.length}개 토픽 (미완료 ${incompleteCount})`);
    return topics;
  }

  private spawnClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '-p',
        '--output-format', 'json',
        '--model', this.model,
        '--no-session-persistence',
      ];

      const [executor, prefixArgs] = resolveExecutor(this.binary);
      const child = spawn(executor, [...prefixArgs, ...args], { env: process.env });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`Claude CLI를 찾을 수 없습니다 (${this.binary}). 'npm i -g @anthropic-ai/claude-code'로 설치하세요.`));
        } else {
          reject(err);
        }
      });

      child.on('close', (code) => {
        if (code !== 0) {
          const errMsg = Buffer.concat(stderr).toString().trim();
          reject(new Error(`claude 프로세스 종료 코드 ${code}: ${errMsg}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString());
      });

      // 프롬프트를 stdin으로 전달 (arg 길이 제한 우회)
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
