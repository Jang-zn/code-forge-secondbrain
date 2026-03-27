import * as vscode from 'vscode';

export class Config {
  private get cfg() {
    return vscode.workspace.getConfiguration('secondbrain');
  }

  get vaultPath(): string {
    return this.cfg.get<string>('vaultPath') ?? '';
  }

  get targetFolder(): string {
    return this.cfg.get<string>('targetFolder') ?? '5.Box/claude-conversations';
  }

  get debounceSeconds(): number {
    return this.cfg.get<number>('debounceSeconds') ?? 30;
  }

  get minMessages(): number {
    return this.cfg.get<number>('minMessages') ?? 3;
  }

  get enabled(): boolean {
    return this.cfg.get<boolean>('enabled') ?? true;
  }

  get summaryModel(): string {
    return this.cfg.get<string>('summaryModel') ?? 'gemini-1.5-flash';
  }

  async setEnabled(value: boolean): Promise<void> {
    await this.cfg.update('enabled', value, vscode.ConfigurationTarget.Global);
  }

  isValid(): boolean {
    return Boolean(this.vaultPath);
  }
}

export class ApiKeyManager {
  private static readonly KEY = 'secondbrain.geminiApiKey';

  constructor(private secrets: vscode.SecretStorage) {}

  async get(): Promise<string | undefined> {
    const stored = await this.secrets.get(ApiKeyManager.KEY);
    if (stored) return stored;
    // Fallback to environment variable
    return process.env.GEMINI_API_KEY;
  }

  async set(key: string): Promise<void> {
    await this.secrets.store(ApiKeyManager.KEY, key);
  }

  async delete(): Promise<void> {
    await this.secrets.delete(ApiKeyManager.KEY);
  }
}
