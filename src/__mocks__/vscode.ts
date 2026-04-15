import { vi } from 'vitest';

export const window = {
  showInformationMessage: vi.fn().mockResolvedValue(undefined),
  showWarningMessage: vi.fn().mockResolvedValue(undefined),
  showErrorMessage: vi.fn().mockResolvedValue(undefined),
  withProgress: vi.fn().mockImplementation(async (_opts: unknown, fn: (progress: unknown, token: unknown) => Promise<unknown>) =>
    fn(
      { report: vi.fn() },
      { onCancellationRequested: vi.fn(), isCancellationRequested: false }
    )
  ),
  createOutputChannel: vi.fn().mockReturnValue({
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }),
};

export const ProgressLocation = { Notification: 15, SourceControl: 1, Window: 10 };

export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => p }),
};

export const workspace = {
  workspaceFolders: undefined as undefined | Array<{ uri: { fsPath: string }; name: string }>,
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn().mockReturnValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  }),
  onDidChangeConfiguration: vi.fn().mockReturnValue({ dispose: vi.fn() }),
};

export const commands = {
  executeCommand: vi.fn().mockResolvedValue(undefined),
  registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
};

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const EventEmitter = vi.fn().mockImplementation(() => ({
  event: vi.fn(),
  fire: vi.fn(),
  dispose: vi.fn(),
}));
