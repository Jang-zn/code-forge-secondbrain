import * as path from 'path';

/**
 * nvm 환경에서 VS Code는 #!/usr/bin/env node shebang을 찾지 못함.
 * 절대 경로 바이너리의 경우 동일 디렉토리 node를 executor로 사용해 우회.
 */
export function resolveExecutor(binary: string): [executor: string, args: string[]] {
  if (path.isAbsolute(binary)) {
    return [path.join(path.dirname(binary), 'node'), [binary]];
  }
  return [binary, []];
}
