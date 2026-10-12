// esbuild를 첫 사용 시점에 읽는다 — 실행 파일 경로를 먼저 잡아야 해서다.
//
// esbuild는 모듈을 읽는 시점에 ESBUILD_BINARY_PATH를 확정하고, 없으면
// require.resolve로 얻은 경로를 그대로 child_process.spawn에 넘긴다. 설치본에서
// 그 경로는 app.asar 안이고, Electron은 execFile과 달리 spawn에는 unpacked 우회를
// 해주지 않아 ENOENT가 난다 — asarUnpack으로 파일을 풀어 두기만 해서는 설치본에서
// 여전히 "구문 검사 서비스 장애"였던 이유다. rg.exe와 같은 처리(search/searchFiles.ts).
//
// 정적 import로는 안 된다. 번들이 ESM이라 import가 본문보다 먼저 평가돼, 환경변수를
// 어디에 두든 esbuild가 이미 읽은 뒤가 된다. 그래서 require로 늦게 읽는다.
import { createRequire } from 'node:module';

type Esbuild = typeof import('esbuild');

const require = createRequire(import.meta.url);
let esbuild: Esbuild | undefined;

export function loadEsbuild(): Esbuild {
  if (esbuild) return esbuild;
  if (!process.env.ESBUILD_BINARY_PATH && process.platform === 'win32' && process.arch === 'x64') {
    try {
      const resolved = require.resolve('@esbuild/win32-x64/esbuild.exe');
      if (/app\.asar[\\/]/.test(resolved)) {
        process.env.ESBUILD_BINARY_PATH = resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      }
    } catch {
      // 개발 실행이나 패키지가 없는 환경: esbuild가 스스로 찾게 둔다
    }
  }
  esbuild = require('esbuild') as Esbuild;
  return esbuild;
}
