// 자격증명이 담기는 파일·디렉터리 판정.
//
// 파일 읽기 도구는 kind가 read라 권한 모드상 자동 허용되지만, 대상이 API 키나
// 개인키면 그대로 모델 컨텍스트에 올라가고 세션 기록에도 남는다. 프롬프트
// 인젝션으로 read_file(".env") → web_fetch(외부)를 잇는 유출 경로가 실제로
// 성립하므로, 이런 경로만 승인 대상으로 끌어올린다.
//
// 차단이 아니라 승인 요구인 이유: 사용자가 자기 .env를 두고 물어보는 것은
// 정상적인 작업이다. 판단을 사용자에게 넘기되 조용히 지나가지 않게 한다.

import { realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { getWorkdir } from '../agent/workdir.ts';
import { getNewbieHome } from '../memory/globalNewbie.ts';

// 경로 어딘가에 이 디렉터리가 있으면 민감하게 취급
const SENSITIVE_DIRECTORIES = new Set([
  '.aws',
  '.gnupg',
  '.ssh',
]);

// 파일 이름이 정확히 일치하면 민감
const SENSITIVE_FILENAMES = new Set([
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.pypirc',
  '_netrc',
  'credentials',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);

// 개인키·인증서 컨테이너 확장자
const SENSITIVE_EXTENSIONS = new Set([
  '.jks',
  '.key',
  '.keystore',
  '.p12',
  '.pem',
  '.pfx',
]);

// .env, .env.local 등. 커밋되는 견본 파일은 제외한다
const ENV_FILE = /^\.env(\..+)?$/;
const SAMPLE_SUFFIX = /\.(example|sample|template|dist)$/;

/**
 * 이 경로가 자격증명 파일인지 판정함.
 * 승인이 필요하면 사용자에게 보여줄 사유를, 아니면 null을 반환한다.
 */
export function sensitivePathReason(filePath: string): string | null {
  const raw = String(filePath ?? '').trim();
  if (!raw) return null;

  const abs = resolve(raw);
  const name = basename(abs);
  const lowerName = name.toLowerCase();

  for (const segment of abs.split(sep)) {
    if (SENSITIVE_DIRECTORIES.has(segment.toLowerCase())) {
      return `${segment} 디렉터리의 파일은 자격증명일 수 있습니다: ${abs}`;
    }
  }

  if (ENV_FILE.test(lowerName) && !SAMPLE_SUFFIX.test(lowerName)) {
    return `환경 변수 파일에는 API 키가 들어 있을 수 있습니다: ${abs}`;
  }

  if (SENSITIVE_FILENAMES.has(lowerName)) {
    return `자격증명 파일일 수 있습니다: ${abs}`;
  }

  if (SENSITIVE_EXTENSIONS.has(extname(lowerName))) {
    return `개인키·인증서 파일일 수 있습니다: ${abs}`;
  }

  return null;
}

/**
 * 읽기 도구용 판정. 입력한 이름뿐 아니라 심볼릭 링크가 실제로 가리키는 곳도 본다.
 *
 * notes.txt가 ~/.ssh/id_rsa를 가리키는 링크면 이름만으로는 평범한 파일이다.
 * 경로가 없거나(아직 만들지 않은 파일) 권한이 없어 실제 경로를 못 구하면 입력한
 * 이름만으로 판정한다 — 그 경우 읽기도 어차피 실패한다.
 */
export function sensitiveReadPathReason(filePath: string): string | null {
  const raw = String(filePath ?? '').trim();
  if (!raw) return null;

  const direct = sensitivePathReason(raw);
  if (direct) return direct;

  try {
    const real = realpathSync(resolve(getWorkdir(), raw));
    const reason = sensitivePathReason(real);
    return reason ? `링크가 가리키는 실제 파일: ${reason}` : null;
  } catch {
    return null;
  }
}

// 써 넣으면 셸을 열 때마다 실행되는 시작 스크립트
const SHELL_STARTUP_FILES = new Set([
  '.bash_login',
  '.bash_logout',
  '.bash_profile',
  '.bashrc',
  '.cshrc',
  '.login',
  '.profile',
  '.tcshrc',
  '.zlogin',
  '.zprofile',
  '.zshenv',
  '.zshrc',
]);

// 앱 데이터 폴더(~/.newbie)에서 실행할 명령이나 자격증명이 담기는 파일
const APP_CONFIG_FILES = new Set(['credentials.enc', 'mcp-auth.enc', 'mcp.json', 'preferences.json']);

function isInside(root: string, abs: string): boolean {
  const inside = relative(root, abs);
  return !inside.startsWith('..') && !isAbsolute(inside);
}

/**
 * 쓰기 도구용 판정. 자격증명 파일에 더해, 써 넣는 순간 다음 실행 때 코드가 돌거나
 * 앱의 설정·자격증명이 바뀌는 곳을 본다. mcp.json에 서버 한 줄을 넣으면 앱을 다시
 * 켤 때 그 명령이 실행되고, .git/config나 훅은 다음 git 명령에서 실행된다.
 */
export function sensitiveWritePathReason(absPath: string): string | null {
  const credential = sensitivePathReason(absPath);
  if (credential) return credential;

  const abs = resolve(absPath);
  const name = basename(abs).toLowerCase();

  if (SHELL_STARTUP_FILES.has(name) || /(^|_)profile\.ps1$/.test(name)) {
    return `셸이 시작할 때 실행하는 파일입니다: ${abs}`;
  }
  if (abs.split(/[\\/]/).some(segment => segment.toLowerCase() === '.git')) {
    return `git 설정·훅은 다음 git 명령에서 코드를 실행할 수 있습니다: ${abs}`;
  }
  if (/[\\/]start menu[\\/]programs[\\/]startup([\\/]|$)/i.test(abs)) {
    return `로그인할 때 실행되는 시작프로그램 폴더입니다: ${abs}`;
  }

  const home = resolve(getNewbieHome());
  if (isInside(home, abs)) {
    const inside = relative(home, abs).toLowerCase();
    if (APP_CONFIG_FILES.has(inside) || inside.split(/[\\/]/)[0] === 'mcp-auth') {
      return `앱의 설정·자격증명 파일입니다: ${abs}`;
    }
  }
  return null;
}
