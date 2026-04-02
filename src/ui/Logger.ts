import * as vscode from 'vscode';

export interface ApiTracker {
  end(resultSummary: string): void;
  fail(err: unknown): void;
}

interface Stats {
  date: string;       // YYYY-MM-DD, 날짜 변경 시 자동 리셋
  apiCalls: number;
  apiSuccess: number;
  apiFail: number;
  apiInvalidated: number;  // 무효화 (응답 받았으나 JSON 파싱 실패 등)
  filesProcessed: number;
  filesSkipped: number;
  notesCreated: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class Logger implements vscode.Disposable {
  private channel: vscode.OutputChannel;
  private _stats: Stats;

  constructor(name = 'SecondBrain') {
    this.channel = vscode.window.createOutputChannel(name);
    this._stats = this.freshStats();
  }

  private freshStats(): Stats {
    return {
      date: today(),
      apiCalls: 0,
      apiSuccess: 0,
      apiFail: 0,
      apiInvalidated: 0,
      filesProcessed: 0,
      filesSkipped: 0,
      notesCreated: 0,
    };
  }

  private checkDateReset(): void {
    if (this._stats.date !== today()) {
      this._stats = this.freshStats();
    }
  }

  get stats(): Stats {
    this.checkDateReset();
    return this._stats;
  }

  show(): void {
    this.channel.show(true);
  }

  private fmt(level: string, message: string, ctx?: Record<string, string | number | boolean>): string {
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    const prefix = `[${hh}:${mm}:${ss}] [${level}] ${message}`;
    if (!ctx || Object.keys(ctx).length === 0) return prefix;
    const ctxStr = Object.entries(ctx).map(([k, v]) => `${k}=${v}`).join(' ');
    return `${prefix} | ${ctxStr}`;
  }

  info(message: string, ctx?: Record<string, string | number | boolean>): void {
    this.channel.appendLine(this.fmt('INFO', message, ctx));
  }

  warn(message: string, ctx?: Record<string, string | number | boolean>): void {
    this.channel.appendLine(this.fmt('WARN', message, ctx));
  }

  error(message: string, ctx?: Record<string, string | number | boolean>): void {
    this.channel.appendLine(this.fmt('ERROR', message, ctx));
  }

  /** 시작 진단 — 설정값 상태 출력 */
  diagnostic(label: string, status: 'OK' | 'MISSING' | 'ERROR', detail?: string): void {
    const line = detail ? `${label}: ${status} (${detail})` : `${label}: ${status}`;
    this.channel.appendLine(this.fmt('DIAG', line));
  }

  /** 처리 건너뜀 — 사유와 컨텍스트 포함 */
  skip(reason: string, ctx?: Record<string, string | number | boolean>): void {
    this.checkDateReset();
    this._stats.filesSkipped++;
    this.channel.appendLine(this.fmt('SKIP', `처리 건너뜀 | 사유="${reason}"`, ctx));
  }

  /** API 호출 시작 — description은 짧은 설명 ("프로젝트 X 메시지 N개 요약") */
  apiStart(model: string, description: string): ApiTracker {
    this.checkDateReset();
    this._stats.apiCalls++;
    const start = Date.now();
    this.channel.appendLine(this.fmt('API', `--> ${model} | ${description}`));

    return {
      end: (resultSummary: string) => {
        this._stats.apiSuccess++;
        const latency = Date.now() - start;
        this.channel.appendLine(this.fmt('API', `<-- OK ${latency}ms | ${resultSummary}`));
        this.printStats();
      },
      fail: (err: unknown) => {
        this._stats.apiFail++;
        const latency = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        this.channel.appendLine(this.fmt('API', `<-- 실패 ${latency}ms | ${msg}`));
        this.printStats();
      },
    };
  }

  /** 현재 통계 한 줄 출력 */
  printStats(): void {
    this.checkDateReset();
    const s = this._stats;
    this.channel.appendLine(this.fmt('STAT', '오늘 통계', {
      'API호출': s.apiCalls,
      '성공': s.apiSuccess,
      '실패': s.apiFail,
      '무효화': s.apiInvalidated,
      '처리': s.filesProcessed,
      '건너뜀': s.filesSkipped,
      '노트': s.notesCreated,
    }));
  }

  dispose(): void {
    this.channel.dispose();
  }
}
