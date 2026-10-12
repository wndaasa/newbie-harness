// 턴별 작업 디렉터리.
//
// 도구는 그동안 process.cwd()를 기준으로 돌았다. 한 번에 한 턴만 돌 때는 문제가
// 없었지만, 세션을 옮겨도 턴이 백그라운드에서 끝까지 도는 지금은 전역 cwd를
// 바꾸는 순간 돌고 있던 턴의 도구가 남의 프로젝트를 건드린다. 그래서 다른
// 프로젝트의 대화로는 턴이 끝나기 전에 옮길 수 없게 막아 두었었다.
//
// 여기서는 cwd를 비동기 컨텍스트에 싣는다. 턴을 runInWorkdir로 감싸면 그 안에서
// 이어지는 모든 await·콜백(도구 실행, 자식 프로세스 spawn, 서브에이전트)이 같은
// 값을 본다. 컨텍스트 밖(UI의 git 칩, 세션 목록 등)에서는 process.cwd()로
// 떨어지므로 기존 호출은 그대로 동작한다.

import { AsyncLocalStorage } from 'node:async_hooks';

const workdir = new AsyncLocalStorage<string>();

/** 지금 턴의 작업 디렉터리. 턴 밖에서는 프로세스의 cwd */
export function getWorkdir(): string {
  return workdir.getStore() ?? process.cwd();
}

/** cwd를 고정한 채 fn을 실행한다. fn 안의 비동기 흐름 전체가 같은 cwd를 본다 */
export function runInWorkdir<T>(cwd: string, fn: () => T): T {
  return workdir.run(cwd, fn);
}
