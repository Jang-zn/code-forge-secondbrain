import * as vscode from 'vscode';

export interface ApiTracker {
  end(response: string): void;
  fail(err: unknown): void;
}

export class Logger implements vscode.Disposable {
  private channel: vscode.OutputChannel;

  constructor(name = 'SecondBrain') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  show(): void {
    this.channel.show(true);
  }

  info(message: string): void {
    this.channel.appendLine(`[${ts()}] [INFO] ${message}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[${ts()}] [WARN] ${message}`);
  }

  error(message: string): void {
    this.channel.appendLine(`[${ts()}] [ERROR] ${message}`);
  }

  apiStart(model: string, promptPreview: string): ApiTracker {
    const start = Date.now();
    const truncPrompt = truncate(promptPreview, 500);
    this.channel.appendLine(`[${ts()}] [API-REQ] model=${model}`);
    this.channel.appendLine(truncPrompt);

    return {
      end: (response: string) => {
        const latency = Date.now() - start;
        const truncResp = truncate(response, 1000);
        this.channel.appendLine(`[${ts()}] [API-RES] latency=${latency}ms`);
        this.channel.appendLine(truncResp);
      },
      fail: (err: unknown) => {
        const latency = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        this.channel.appendLine(`[${ts()}] [API-ERR] latency=${latency}ms error=${msg}`);
      },
    };
  }

  dispose(): void {
    this.channel.dispose();
  }
}

function ts(): string {
  return new Date().toISOString();
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '... (truncated)' : text;
}
