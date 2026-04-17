import * as path from 'path';
import { spawn } from 'child_process';
import type { ParsedSession } from '../parser/types';
import type { Logger } from '../ui/Logger';
import type { SummaryResult, Summarizer } from './types';
import { buildSummaryPrompt, parseSummaryTopics } from './summaryUtils';
import { compressMessages } from './messageFilter';
import { resolveExecutor } from '../spawnHelper';

export class ClaudeCLISummarizer implements Summarizer {
  constructor(
    private binary = 'claude',
    private model = 'sonnet',
    private logger?: Logger
  ) {}

  private static readonly MAX_MSG_CHARS = 4000;
  private static readonly TIMEOUT_MS = 5 * 60 * 1000; // 5분

  async summarize(session: ParsedSession, previousContext?: string, signal?: AbortSignal): Promise<SummaryResult[]> {
    const { text: conversationText, originalCount, keptCount, fallback } = compressMessages(
      session.messages,
      ClaudeCLISummarizer.MAX_MSG_CHARS,
    );

    if (fallback) {
      const projectName = path.basename(session.projectPath) || 'unknown';
      this.logger?.warn('필터 과도, 원본 fallback 사용', { project: projectName, 원본: originalCount });
    }

    const prompt = buildSummaryPrompt(session, conversationText, previousContext);

    const projectName = path.basename(session.projectPath) || 'unknown';
    const tracker = this.logger?.apiStart(this.model, `${projectName} ${keptCount}/${originalCount}개 메시지 요약`);

    let rawText: string;
    try {
      rawText = await this.spawnClaude(prompt, signal);
    } catch (err) {
      tracker?.fail(err);
      throw err;
    }

    // --output-format json wraps the result: { type, subtype, result, ... }
    const textToParse = this.unwrapClaudeJson(rawText);

    let topics: SummaryResult[];
    const allIndices = session.messages.map((_, i) => i);
    try {
      topics = parseSummaryTopics(textToParse, allIndices, this.logger);
    } catch (firstErr) {
      // sanitize 재시도도 실패 — 강조 프롬프트로 CLI 1회 재호출
      const posMatch = firstErr instanceof Error ? firstErr.message.match(/position (\d+)/) : null;
      const errPos = posMatch ? Number(posMatch[1]) : null;
      this.logger?.warn('JSON 파싱 실패, CLI 재호출 시도', {
        project: projectName,
        오류위치: textToParse.slice(
          Math.max(0, errPos !== null ? errPos - 100 : 0),
          Math.min(textToParse.length, errPos !== null ? errPos + 100 : 200),
        ).replace(/\n/g, '↵'),
      });
      let retryText: string;
      try {
        const retryPrompt = prompt + '\n\n중요: JSON 문자열 값 내부에 실제 개행 문자를 절대 쓰지 마세요. 반드시 \\n 두 글자로 표현하세요.';
        retryText = await this.spawnClaude(retryPrompt, signal);
      } catch {
        tracker?.fail(firstErr);
        throw firstErr;
      }
      try {
        topics = parseSummaryTopics(this.unwrapClaudeJson(retryText), allIndices, this.logger);
      } catch {
        tracker?.fail(firstErr);
        throw firstErr;
      }
    }

    const incompleteCount = topics.filter(t => t.incomplete === true).length;
    tracker?.end(`${topics.length}개 토픽 (미완료 ${incompleteCount})`);
    return topics;
  }

  private unwrapClaudeJson(raw: string): string {
    try {
      const outer = JSON.parse(raw) as { result?: string; content?: string };
      return (outer.result ?? outer.content ?? raw).trim();
    } catch {
      return raw.trim();
    }
  }

  private spawnClaude(prompt: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '-p',
        '--output-format', 'json',
        '--model', this.model,
        '--no-session-persistence',
      ];

      const { cmd, args: prefixArgs, spawnOpts } = resolveExecutor(this.binary);
      const child = spawn(cmd, [...prefixArgs, ...args], { env: process.env, ...spawnOpts });

      if (signal) {
        const onAbort = () => {
          child.kill();
          reject(new Error('취소됨'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // Clean up listener after child exits
        child.once('close', () => signal.removeEventListener('abort', onAbort));
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`claude 프로세스 타임아웃 (${ClaudeCLISummarizer.TIMEOUT_MS / 1000}초 초과)`));
      }, ClaudeCLISummarizer.TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`Claude CLI를 찾을 수 없습니다 (${this.binary}). 'npm i -g @anthropic-ai/claude-code'로 설치하세요.`));
        } else {
          reject(err);
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const errMsg = Buffer.concat(stderr).toString().trim();
          reject(new Error(`claude 프로세스 종료 코드 ${code}: ${errMsg}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString());
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
