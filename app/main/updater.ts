// 자동 업데이트.
//
// 설치본이 켜질 때 GitHub Release(electron-builder.yml의 publish)에서 새 버전이
// 있는지 확인한다. 예전에는 조용히 내려받아 종료할 때 설치했는데, 사용자가
// 모르는 사이 앱이 바뀌는 것이 오히려 불안하다는 피드백이 있었다. 그래서 확인
// 결과만 사이드바에 띄우고, 받기와 설치는 사용자가 눌렀을 때만 진행한다.
// 공개 저장소의 Release라 토큰 없이 받는다.

import { app } from 'electron';
// electron-updater는 CommonJS라 이름 가져오기가 번들러에 따라 깨진다. 기본
// 가져오기에서 꺼내 쓰는 쪽이 어디서나 같다
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

/** 렌더러가 그대로 그리는 업데이트 상태. renderer/src/types.ts와 같은 모양 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'available'; version: string }
  | {
      phase: 'downloading';
      version: string;
      percent: number;
      transferred: number;
      total: number;
    }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; version: string; message: string };

let state: UpdateState = { phase: 'idle' };
let publish: (state: UpdateState) => void = () => {};

function setState(next: UpdateState): void {
  state = next;
  publish(state);
}

export function getUpdateState(): UpdateState {
  return state;
}

/**
 * 업데이트 확인을 시작한다. 개발 실행(리포에서 시작)은 app-update.yml이 없어
 * 확인할 수 없으므로 아무것도 하지 않는다.
 *
 * 확인 단계의 오류는 알리지 않는다. 오프라인이거나 Release가 아직 없는 것이
 * 대부분이라 켤 때마다 빨간 줄이 뜨면 소음이다.
 * onState는 상태가 바뀔 때마다 렌더러로 보내는 통로다.
 */
export function startAutoUpdate(onState: (state: UpdateState) => void): void {
  publish = onState;
  if (!app.isPackaged) return;

  // 받기는 사용자가 누를 때만 (downloadUpdate). 받은 뒤 다시 시작을 미루면
  // 앱을 닫을 때 설치된다 — 받아 놓고 영영 안 깔리는 것보다 낫다
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', info => {
    setState({ phase: 'available', version: info.version });
  });
  autoUpdater.on('download-progress', progress => {
    if (state.phase !== 'downloading') return;
    setState({
      ...state,
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    });
  });
  autoUpdater.on('update-downloaded', info => {
    setState({ phase: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', error => {
    console.warn('[updater]', error.message);
  });

  void autoUpdater.checkForUpdates().catch(error => {
    console.warn('[updater]', error instanceof Error ? error.message : String(error));
  });
}

/**
 * 사용자가 받기를 눌렀다. 받을 것이 없거나 이미 받는 중이면 지금 상태를 그대로
 * 돌려준다. 실패는 사이드바에 남겨 다시 누를 수 있게 한다
 */
export function downloadUpdate(): UpdateState {
  if (state.phase !== 'available' && state.phase !== 'error') return state;
  const { version } = state;
  setState({ phase: 'downloading', version, percent: 0, transferred: 0, total: 0 });
  void autoUpdater.downloadUpdate().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[updater]', message);
    setState({ phase: 'error', version, message });
  });
  return state;
}

/** 사용자가 다시 시작을 눌렀다. 받아 둔 것이 없으면 아무것도 하지 않는다 */
export function installUpdate(): void {
  if (state.phase !== 'downloaded') return;
  // 조용히 설치하고(설치 프로그램이 oneClick이라 물을 것도 없다) 바로 다시 띄운다
  autoUpdater.quitAndInstall(true, true);
}
