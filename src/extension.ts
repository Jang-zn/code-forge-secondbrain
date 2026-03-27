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
    vscode.commands.registerCommand('secondbrain.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Gemini API key',
        password: true,
        placeHolder: 'AIza...',
        ignoreFocusOut: true,
      });
      if (key) {
        await apiKeyManager.set(key);
        vscode.window.showInformationMessage('SecondBrain: Gemini API key saved.');
      }
    }),

    vscode.commands.registerCommand('secondbrain.processAll', async () => {
      if (!config.isValid()) {
        vscode.window.showWarningMessage(
          'SecondBrain: Set secondbrain.vaultPath first.'
        );
        return;
      }
      await watcher?.processAll();
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
