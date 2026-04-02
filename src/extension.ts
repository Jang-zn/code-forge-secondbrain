import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { Config, ApiKeyManager } from './config';
import { resolveExecutor } from './spawnHelper';
import { ClaudeWatcher } from './watcher/ClaudeWatcher';
import { StatusBar } from './ui/StatusBar';
import { Logger } from './ui/Logger';

const CLAUDE_PROJECTS_PATH = path.join(os.homedir(), '.claude', 'projects');

let watcher: ClaudeWatcher | undefined;
let statusBar: StatusBar | undefined;
let logger: Logger | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const config = new Config();
  const apiKeyManager = new ApiKeyManager(context.secrets);
  statusBar = new StatusBar();
  logger = new Logger();

  // 시작 진단
  logger.info('SecondBrain 시작');
  logger.diagnostic('Vault 경로', config.vaultPath ? 'OK' : 'MISSING', config.vaultPath || '미설정 — Setup 명령 실행 필요');
  logger.diagnostic('활성화', config.enabled ? 'OK' : 'MISSING', config.enabled ? '사용 중' : '비활성화됨');
  logger.diagnostic('Claude 프로젝트 폴더', fs.existsSync(CLAUDE_PROJECTS_PATH) ? 'OK' : 'MISSING', CLAUDE_PROJECTS_PATH);
  logger.diagnostic('요약 모델', 'OK', config.summaryModel);

  logger.diagnostic('요약 엔진', 'OK', config.summaryProvider === 'claude-cli'
    ? `claude-cli (${config.claudeCliModel})`
    : `gemini (${config.summaryModel})`);

  // Gemini 사용 시에만 API 키 확인
  if (config.summaryProvider === 'gemini') {
    apiKeyManager.get().then(key => {
      logger?.diagnostic('Gemini API 키', key ? 'OK' : 'MISSING', key ? '설정됨' : '미설정 — Setup 명령 실행 필요');
    });
  }

  watcher = new ClaudeWatcher(config, apiKeyManager, statusBar, logger);

  if (config.enabled) {
    watcher.start();
  } else {
    logger.info('감시 미시작: 확장이 비활성화 상태');
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

      // Step 2: Gemini API key (claude-cli 모드에서는 스킵)
      if (config.summaryProvider === 'gemini') {
        const key = await vscode.window.showInputBox({
          prompt: '[2/2] Gemini API 키를 입력하세요',
          password: true,
          placeHolder: 'AIza...',
          ignoreFocusOut: true,
        });
        if (key) {
          await apiKeyManager.set(key);
        }
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

    vscode.commands.registerCommand('secondbrain.showLogs', () => {
      logger?.show();
    }),

    vscode.commands.registerCommand('secondbrain.testConnection', async () => {
      const provider = config.summaryProvider;

      if (provider === 'claude-cli') {
        const binary = config.claudeCliBinary;
        const model = config.claudeCliModel;
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'SecondBrain: Claude CLI 연결 테스트 중...' },
          () => new Promise<void>((resolve, reject) => {
            const [executor, prefixArgs] = resolveExecutor(binary);
            execFile(executor, [...prefixArgs, '--version'], { env: process.env, timeout: 5000 }, (err, stdout) => {
              if (err) {
                reject(err);
                const code = (err as NodeJS.ErrnoException).code;
                if (code === 'ENOENT') {
                  vscode.window.showErrorMessage(
                    `SecondBrain: Claude CLI를 찾을 수 없습니다 (${binary}). 터미널에서 'npm i -g @anthropic-ai/claude-code'로 설치하세요.`
                  );
                } else {
                  vscode.window.showErrorMessage(
                    `SecondBrain: Claude CLI 실행 실패 — ${err.message}. 터미널에서 'claude'를 실행해 로그인 상태를 확인하세요.`
                  );
                }
              } else {
                resolve();
                const version = stdout.trim();
                vscode.window.showInformationMessage(
                  `SecondBrain: Claude CLI 확인 완료 (${version}, 모델: ${model})`
                );
              }
            });
          })
        );
      } else {
        // Gemini 연결 테스트
        const key = await apiKeyManager.get();
        if (!key) {
          vscode.window.showErrorMessage('SecondBrain: Gemini API 키가 설정되지 않았습니다. "SecondBrain: Set Gemini API Key"를 실행하세요.');
          return;
        }
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'SecondBrain: Gemini 연결 테스트 중...' },
          async () => {
            try {
              const { GoogleGenerativeAI } = await import('@google/generative-ai');
              const genAI = new GoogleGenerativeAI(key);
              const model = genAI.getGenerativeModel({ model: config.summaryModel });
              await model.generateContent('ping');
              vscode.window.showInformationMessage(
                `SecondBrain: Gemini 연결 성공 (모델: ${config.summaryModel})`
              );
            } catch (err) {
              vscode.window.showErrorMessage(
                `SecondBrain: Gemini 연결 실패 — ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        );
      }
    }),

    // Re-create watcher when config changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('secondbrain')) return;
      if (config.enabled) {
        watcher?.dispose();
        watcher = new ClaudeWatcher(config, apiKeyManager, statusBar!, logger);
        watcher.start();
        statusBar?.setIdle();
      }
    }),

    watcher,
    statusBar,
    logger,
  );
}


export function deactivate(): void {
  watcher?.dispose();
  statusBar?.dispose();
  logger?.dispose();
}
