/*
 * 렌더러 테스트용 DOM 준비.
 *
 * 함수로 내보내고 각 파일이 명시적으로 부른다. 부수효과만 있는 import로 두면
 * 쓰지 않는 파일에서 통째로 제거돼 DOM이 등록되지 않는다 — 실제로 그렇게 깨졌다.
 *
 * bun은 테스트 파일들을 한 프로세스에서 돌리므로 등록은 한 번만 한다. 전역
 * preload로 두지 않는 이유는 happy-dom이 fetch를 갈아끼워서, HTTP를 모킹하는
 * 코어 테스트가 같은 프로세스에서 깨지기 때문이다 (package.json의 test:core/test:ui).
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const FLAG = '__newbieDomRegistered';

/**
 * DOM을 등록하고 최소 브릿지를 세운다.
 *
 * theme.ts는 모듈을 읽는 순간 window.newbie.setThemeColors를 부르므로,
 * 컴포넌트를 불러오기 전에 이 함수가 먼저 돌아야 한다.
 */
export function setupDom(): void {
  const global = globalThis as Record<string, unknown>;
  if (!global[FLAG]) {
    GlobalRegistrator.register();
    global[FLAG] = true;
  }
  (global.window as { newbie?: unknown }).newbie = {
    setThemeColors: () => {},
    setTitlebarShade: () => {},
  };
}
