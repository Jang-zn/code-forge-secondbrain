import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SummaryResult, Summarizer } from '../summarizer/types';
import type { ParsedSession } from '../parser/types';

/** 지정된 결과를 반환하는 Fake Summarizer */
export class FakeSummarizer implements Summarizer {
  public callCount = 0;
  public lastSession?: ParsedSession;
  public lastPreviousContext?: string;
  public delay = 0;
  public shouldThrow?: Error;

  constructor(public results: SummaryResult[] = [makeSummaryResult()]) {}

  async summarize(session: ParsedSession, previousContext?: string, signal?: AbortSignal): Promise<SummaryResult[]> {
    this.callCount++;
    this.lastSession = session;
    this.lastPreviousContext = previousContext;
    if (signal?.aborted) throw new Error('취소됨');
    if (this.delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('취소됨'));
        }, { once: true });
      });
    }
    if (this.shouldThrow) throw this.shouldThrow;
    return this.results;
  }
}

/** 기본 SummaryResult 생성 */
export function makeSummaryResult(overrides: Partial<SummaryResult> = {}): SummaryResult {
  return {
    title: 'Test Summary',
    summary: 'Test summary content',
    keyTopics: ['topic1'],
    decisions: ['decision1'],
    codeChanges: ['change1'],
    tags: ['test'],
    messageIndices: [0, 1],
    investigation: '',
    decisionRationale: '',
    insights: [],
    ...overrides,
  };
}

/** 임시 작업 공간 생성 */
export function createTempWorkspace(): {
  rootDir: string;
  projectsDir: string;
  vaultDir: string;
  stateDir: string;
  cleanup: () => void;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-integ-'));
  const projectsDir = path.join(rootDir, 'projects');
  const vaultDir = path.join(rootDir, 'vault');
  const stateDir = path.join(rootDir, 'state');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    rootDir,
    projectsDir,
    vaultDir,
    stateDir,
    cleanup: () => {
      try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** 테스트용 .jsonl 파일 생성 — Claude CLI 실제 포맷으로 작성 */
export function writeJsonlFile(
  dir: string,
  filename: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  baseTime?: number,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const t = baseTime ?? Date.now();
  const sessionId = `session-${filename}-${t}`;
  const lines = messages.map((m, i) => JSON.stringify({
    type: m.role === 'user' ? 'user' : 'assistant',
    uuid: `uuid-${filename}-${i}`,
    timestamp: new Date(t - (messages.length - i) * 60_000).toISOString(),
    sessionId,
    cwd: '/tmp/test-project',
    message: {
      role: m.role === 'user' ? 'user' : 'assistant',
      content: [{ type: 'text', text: m.content }],
    },
  }));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  return filePath;
}

/** 테스트용 Config 객체 */
export function makeIntegrationConfig(vaultDir: string, overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    vaultPath: vaultDir,
    targetFolder: 'Notes',
    summaryProvider: 'claude-cli',
    summaryModel: 'sonnet',
    claudeCliBinary: 'claude',
    claudeCliModel: 'sonnet',
    minMessages: 2,
    excludeProjects: [] as string[],
    isValid: () => true,
    ...overrides,
  };
}

/** 노트 파일이 실제로 생성되었는지 확인 (vault 디렉토리 재귀 탐색) */
export function findNoteFiles(vaultDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) results.push(full);
      }
    } catch {}
  }
  walk(vaultDir);
  return results;
}

/** StatusBar stub */
export function makeStatusBar() {
  return {
    setProcessing: () => {},
    setIdle: () => {},
    setSuccess: (_title: string) => {},
    setError: (_msg: string) => {},
    setDisabled: () => {},
    dispose: () => {},
  };
}

/** Logger stub */
export function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    skip: () => {},
    apiStart: () => ({ end: () => {}, fail: () => {} }),
    printStats: () => {},
    stats: { filesProcessed: 0, notesCreated: 0 },
  };
}

/** ApiKeyManager stub */
export function makeApiKeyManager() {
  return {
    get: async () => 'test-key',
    set: async (_key: string) => {},
  };
}
