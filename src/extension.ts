import * as vscode from 'vscode';
import { Config, ApiKeyManager } from './config';
import { ClaudeWatcher } from './watcher/ClaudeWatcher';
import { StatusBar } from './ui/StatusBar';

let watcher: ClaudeWatcher | undefined;
let statusBar: StatusBar | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const config = new Config();
  const apiKeyManager = new ApiKeyManager(context.secrets);
  statusBar = new StatusBar();

  watcher = new ClaudeWatcher(config, apiKeyManager, statusBar);

  if (config.enabled) {
    watcher.start();
  } else {
    statusBar.setDisabled();
  }

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('secondbrain.setup', async () => {
      // Step 1: Vault path
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Vault 폴더 선택',
        title: '[1/2] Obsidian Vault 루트 폴더를 선택하세요',
      });
      if (!uris || uris.length === 0) return;
      await config.setVaultPath(uris[0].fsPath);

      // Step 2: Gemini API key
      const key = await vscode.window.showInputBox({
        prompt: '[2/2] Gemini API 키를 입력하세요',
        password: true,
        placeHolder: 'AIza...',
        ignoreFocusOut: true,
      });
      if (key) {
        await apiKeyManager.set(key);
      }

      vscode.window.showInformationMessage(
        `SecondBrain: 설정 완료 — Vault: ${uris[0].fsPath}`
      );
    }),

    vscode.commands.registerCommand('secondbrain.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Gemini API 키를 입력하세요',
        password: true,
        placeHolder: 'AIza...',
        ignoreFocusOut: true,
      });
      if (key) {
        await apiKeyManager.set(key);
        vscode.window.showInformationMessage('SecondBrain: Gemini API key saved.');
      }
    }),

    vscode.commands.registerCommand('secondbrain.setVaultPath', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Vault 폴더 선택',
        title: 'Obsidian Vault 루트 폴더를 선택하세요',
      });
      if (!uris || uris.length === 0) return;
      await config.setVaultPath(uris[0].fsPath);
      vscode.window.showInformationMessage(
        `SecondBrain: Vault 경로 설정 완료 → ${uris[0].fsPath}`
      );
    }),

    vscode.commands.registerCommand('secondbrain.processCurrent', async () => {
      if (!config.isValid()) {
        vscode.window.showWarningMessage(
          'SecondBrain: Set secondbrain.vaultPath first.'
        );
        return;
      }
      await watcher?.processCurrent();
    }),

    vscode.commands.registerCommand('secondbrain.enable', async () => {
      await config.setEnabled(true);
      watcher?.start();
      statusBar?.setIdle();
      vscode.window.showInformationMessage('SecondBrain: Enabled.');
    }),

    vscode.commands.registerCommand('secondbrain.disable', async () => {
      await config.setEnabled(false);
      watcher?.dispose();
      statusBar?.setDisabled();
      vscode.window.showInformationMessage('SecondBrain: Disabled.');
    }),

    // Re-create watcher when config changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('secondbrain')) return;
      if (config.enabled) {
        watcher?.dispose();
        watcher = new ClaudeWatcher(config, apiKeyManager, statusBar!);
        watcher.start();
        statusBar?.setIdle();
      }
    }),

    watcher,
    statusBar,
  );
}


export function deactivate(): void {
  watcher?.dispose();
  statusBar?.dispose();
}
