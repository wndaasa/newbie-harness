// 펫 프로세스 기동과 제어.
//
// 펫은 본앱과 수명이 다르다 — 본앱과 함께 뜨지만 본앱을 닫아도 남는다. 그래서
// 같은 실행 파일을 --pet 인자로 detached spawn 한다(app/main/boot.ts가 분기).
//
// 제어 채널은 Electron의 단일 인스턴스 락이다. 펫 모드만 락을 잡으므로,
// --pet에 명령 인자를 붙여 한 번 더 띄우면 떠 있는 펫이 second-instance
// 이벤트로 인자를 받고 새 프로세스는 락 실패로 바로 사라진다. 파일 감시보다
// 느리지만 유실이 없고 Electron 기본 기능만 쓴다.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { app } from 'electron';
import { getPetPidPath } from './petSettings.ts';

export const PET_FLAG = '--pet';
export const PET_QUIT_FLAG = '--pet-quit';
export const PET_RELOAD_FLAG = '--pet-reload';

// ---------- 실행 여부 ----------
//
// 본앱은 락을 잡지 않으므로 펫이 떠 있는지 락으로는 알 수 없다. 펫이 락을 얻으면
// pid를 파일에 적고 종료 때 지운다. 강제 종료로 파일이 남을 수 있어 pid가 살아
// 있는지도 같이 본다.

/** 펫 프로세스가 부른다 — 락을 얻은 직후 */
export function markPetRunning(): void {
  try {
    const path = getPetPidPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid), 'utf8');
  } catch {
    // 못 적어도 펫은 떠야 한다. 설정 탭의 상태 표시만 틀린다
  }
}

export function unmarkPetRunning(): void {
  rmSync(getPetPidPath(), { force: true });
}

export function isPetRunning(): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(getPetPidPath(), 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0은 보내지 않고 존재만 확인한다
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function launch(extra: string[]): void {
  // 개발 실행(electron .)은 앱 경로를 첫 인자로 줘야 같은 package.json main을 탄다.
  // 설치본은 exe 자체가 앱이라 인자만 붙인다
  const args = app.isPackaged ? [PET_FLAG, ...extra] : [app.getAppPath(), PET_FLAG, ...extra];
  const child = spawn(process.execPath, args, {
    detached: true,
    // 본앱의 stdio를 물려주면 본앱이 끝나도 파이프가 살아 있어 셸이 기다린다
    stdio: 'ignore',
    // 개발 서버 주소(ELECTRON_RENDERER_URL)와 NEWBIE_HOME을 그대로 넘긴다
    env: process.env,
  });
  child.unref();
}

/** 펫을 띄운다. 이미 떠 있으면 락 실패로 조용히 사라지므로 중복되지 않는다 */
export function startPet(): void {
  launch([]);
}

/** 떠 있는 펫을 종료한다. 없으면 아무 일도 없다 */
export function quitPet(): void {
  launch([PET_QUIT_FLAG]);
}

/** 떠 있는 펫이 설정과 이미지를 다시 읽게 한다. 없으면 새로 띄운다 */
export function reloadPet(): void {
  launch([PET_RELOAD_FLAG]);
}
