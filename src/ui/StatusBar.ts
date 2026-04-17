import * as vscode from 'vscode';

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'secondbrain.enable';
    this.setIdle();
    this.item.show();
  }

  setIdle(): void {
    this.clearPendingTimer();
    this.item.text = '$(brain) SecondBrain';
    this.item.tooltip = 'SecondBrain: Watching Claude conversations';
    this.item.color = undefined;
  }

  setDisabled(): void {
    this.clearPendingTimer();
    this.item.text = '$(brain) SecondBrain (off)';
    this.item.tooltip = 'SecondBrain: Disabled — click to enable';
    this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  }

  setProcessing(): void {
    this.clearPendingTimer();
    this.item.text = '$(sync~spin) SecondBrain';
    this.item.tooltip = 'SecondBrain: Processing conversation…';
    this.item.color = undefined;
  }

  setSuccess(title: string, count = 1): void {
    this.clearPendingTimer();
    this.item.text = count > 1 ? `$(check) SecondBrain: ${count}개` : `$(check) SecondBrain`;
    this.item.tooltip = count > 1
      ? `SecondBrain: ${count}개 저장됨 (마지막: "${title}")`
      : `SecondBrain: Saved "${title}"`;
    this.item.color = new vscode.ThemeColor('statusBarItem.prominentForeground');

    // Auto-revert to idle after 5s
    this.clearTimer = setTimeout(() => this.setIdle(), 5_000);
  }

  setError(msg: string): void {
    this.clearPendingTimer();
    this.item.text = '$(error) SecondBrain';
    this.item.tooltip = `SecondBrain error: ${msg}`;
    this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');

    // Auto-revert after 10s
    this.clearTimer = setTimeout(() => this.setIdle(), 10_000);
  }

  private clearPendingTimer(): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }

  dispose(): void {
    this.clearPendingTimer();
    this.item.dispose();
  }
}
