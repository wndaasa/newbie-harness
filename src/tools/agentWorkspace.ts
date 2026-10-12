// 에이전트 작업 폴더: <작업 폴더>/.newbie
//
// 에이전트가 만든 파일이 프로젝트 루트에 쌓였다. 시스템 프롬프트가 임시 파일을
// 작업 폴더에 tmp_ 이름으로 만들라고 했고, 남길 문서나 SQL은 둘 곳을 정하지 않았다.
// 루트에 docs/·sql/을 새로 만들면 프로젝트의 기존 폴더와 부딪칠 수 있어, 에이전트
// 몫은 전부 이 폴더 하나 아래에 둔다.
//
//   tmp/<세션ID>/          한 번 쓰고 버릴 파일. 확인 없이 지우고, 세션을 지우면 같이 지운다
//   docs/ sql/ scripts/    남길 산출물
//
// git 제외 처리는 하지 않는다. 산출물을 커밋할지는 사용자가 정한다.

import { isAbsolute, join, relative, resolve } from 'node:path';
import { getWorkdir } from '../agent/workdir.ts';
import { getNewbieHome } from '../memory/globalNewbie.ts';

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 작업 폴더가 홈이면 <홈>/.newbie가 앱 데이터 폴더(NEWBIE_HOME 기본값)와 겹친다.
 * 산출물이 세션 파일·설정과 섞이지 않게 그때는 이름을 바꾼다
 */
export function agentWorkspaceDir(workdir = getWorkdir()): string {
  const plain = resolve(workdir, '.newbie');
  return samePath(plain, resolve(getNewbieHome())) ? resolve(workdir, '.newbie-work') : plain;
}

export function agentTmpRoot(workdir?: string): string {
  return join(agentWorkspaceDir(workdir), 'tmp');
}

export function agentTmpDir(sessionId: string, workdir?: string): string {
  return join(agentTmpRoot(workdir), sessionId);
}

/** 임시 폴더 안의 경로인가. tmp 폴더 자체는 아니다 — 모든 세션의 임시 파일을 한 번에 지우지 않게 */
export function isInAgentTmp(absPath: string, workdir?: string): boolean {
  const inside = relative(agentTmpRoot(workdir), resolve(absPath));
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}
