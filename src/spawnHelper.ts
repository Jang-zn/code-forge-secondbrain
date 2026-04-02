import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import type { Logger } from './ui/Logger';

export interface ExecutorResult {
  cmd: string;
  args: string[];
  spawnOpts: { shell?: boolean };
}

/**
 * nvm 환경에서 VS Code는 #!/usr/bin/env node shebang을 찾지 못함.
 * 절대 경로 바이너리의 경우 동일 디렉토리 node를 executor로 사용해 우회.
 * Windows에서는 .cmd 파일 실행을 위해 shell: true 사용.
 */
export function resolveExecutor(binary: string): ExecutorResult {
  if (process.platform === 'win32') {
    return { cmd: binary, args: [], spawnOpts: { shell: true } };
  }
  if (path.isAbsolute(binary)) {
    return { cmd: path.join(path.dirname(binary), 'node'), args: [binary], spawnOpts: {} };
  }
  return { cmd: binary, args: [], spawnOpts: {} };
}

/**
 * Claude CLI 바이너리 자동 감지.
 * 탐색 순서: which/where → npm root -g → 플랫폼별 알려진 경로 → 기본값 'claude'
 */
export async function findClaudeBinary(logger?: Logger): Promise<string> {
  const isWin = process.platform === 'win32';
  const candidates: Array<() => Promise<string | null>> = [
    () => tryWhich(isWin, logger),
    () => tryNpmRoot(isWin, logger),
    () => tryKnownPaths(isWin, logger),
  ];

  for (const candidate of candidates) {
    const result = await candidate();
    if (result) return result;
  }

  logger?.diagnostic('Claude CLI 자동 감지', 'MISSING', 'claude (기본값 사용 — 자동 감지 실패)');
  return 'claude';
}

function tryWhich(isWin: boolean, logger?: Logger): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = isWin ? 'where' : 'which';
    const target = isWin ? 'claude.cmd' : 'claude';
    execFile(cmd, [target], { shell: isWin, timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        logger?.info(`Claude CLI 탐색: ${cmd} → 실패`);
        resolve(null);
        return;
      }
      const found = stdout.trim().split('\n')[0].trim();
      logger?.info(`Claude CLI 탐색: ${cmd} → ${found} (성공)`);
      resolve(found);
    });
  });
}

function tryNpmRoot(isWin: boolean, logger?: Logger): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('npm', ['root', '-g'], { shell: isWin, timeout: 5000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        logger?.info('Claude CLI 탐색: npm root -g → 실패');
        resolve(null);
        return;
      }
      const npmRoot = stdout.trim(); // e.g. /usr/local/lib/node_modules
      const binDir = path.join(npmRoot, '..', 'bin');
      const candidate = isWin
        ? path.join(path.dirname(npmRoot), 'claude.cmd')
        : path.join(binDir, 'claude');
      logger?.info(`Claude CLI 탐색: npm root -g → ${candidate} 확인 중`);
      if (fs.existsSync(candidate)) {
        logger?.info(`Claude CLI 탐색: npm root -g → ${candidate} (성공)`);
        resolve(candidate);
      } else {
        logger?.info('Claude CLI 탐색: npm root -g → 파일 없음');
        resolve(null);
      }
    });
  });
}

function tryKnownPaths(isWin: boolean, logger?: Logger): Promise<string | null> {
  const home = os.homedir();
  let candidates: string[];

  if (isWin) {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    candidates = [
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(localAppData, 'npm', 'claude.cmd'),
    ];
  } else {
    // nvm 경로: 최신 버전 우선으로 정렬
    const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
    const nvmCandidates: string[] = [];
    if (fs.existsSync(nvmVersionsDir)) {
      try {
        const versions = fs.readdirSync(nvmVersionsDir)
          .filter(v => v.startsWith('v'))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const v of versions) {
          nvmCandidates.push(path.join(nvmVersionsDir, v, 'bin', 'claude'));
        }
      } catch {}
    }
    candidates = [
      ...nvmCandidates,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/bin/claude',
    ];
  }

  for (const candidate of candidates) {
    logger?.info(`Claude CLI 탐색: 알려진 경로 → ${candidate} 확인 중`);
    if (fs.existsSync(candidate)) {
      logger?.info(`Claude CLI 탐색: 알려진 경로 → ${candidate} (성공)`);
      return Promise.resolve(candidate);
    }
  }

  logger?.info('Claude CLI 탐색: 알려진 경로 → 없음');
  return Promise.resolve(null);
}
