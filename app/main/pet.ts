// Newbie 데스크탑 펫 — Electron 메인 프로세스 (--pet 모드, boot.ts가 분기).
//
// 설계 원칙: 펫은 얇은 클라이언트다. LLM을 호출하지 않고, 본앱·CLI와 공유하는
// ~/.newbie/memory/ 파일들이 유일한 데이터 채널이다. 저장소 접근은 전부
// src/memory/*를 직접 쓴다 — 규약을 복제하면 로깅 정책(민감정보 마스킹,
// NEWBIE_DISABLE_LOGGING, 길이 제한)이 조용히 어긋난다.
//
// 본앱과 프로세스가 다르다. 본앱이 시작할 때 띄우지만 본앱을 닫아도 남는다.
// 본앱의 제어(종료·새로고침)는 petLauncher.ts가 --pet 인자로 한 번 더 띄우는
// 프로세스를 단일 인스턴스 락의 second-instance 이벤트로 받아 처리한다.
import { app, BrowserWindow, ipcMain, nativeImage, screen } from 'electron';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendCheckin, hasTodayCheckin, isValidMood } from '../../src/memory/checkin.ts';
import { appendToLog } from '../../src/memory/logger.ts';
import {
  getNextPendingQuestion,
  resolveQuestion,
} from '../../src/memory/questions.ts';
import {
  PET_QUIT_FLAG,
  PET_RELOAD_FLAG,
  markPetRunning,
  unmarkPetRunning,
} from './petLauncher.ts';
import { placeWindow, startRoaming, type Roamer } from './petRoam.ts';
import {
  PET_ANIMATION_SLOTS,
  loadPetSettings,
  savePetSettings,
  type PetAnimation,
  type PetSettings,
} from './petSettings.ts';
import { rendererUrl } from './rendererUrl.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const IS_SMOKE = process.argv.includes('--smoke');

// 떠돌기를 멈춰야 하는지는 렌더러가 안다(말풍선·hover·드래그·설정·조용한 시간).
// 렌더러가 처음 알려 오기 전에는 멈춰 있는다
let rendererHeld = true;
let roamer: Roamer | null = null;

// ---------- 단일 인스턴스 ----------
//
// 본앱은 락을 잡지 않으므로 펫끼리만 겨룬다. 본앱을 다시 켜서 펫을 또 띄워도
// 두 번째는 여기서 끝난다. 명령 인자만 들고 온 프로세스도 같은 길로 사라진다 —
// 떠 있는 펫이 second-instance로 인자를 받는다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (process.argv.includes(PET_QUIT_FLAG)) {
  // 종료시킬 펫이 없다. 락을 얻었다고 펫이 되면 안 된다
  app.quit();
} else {
  // --pet-reload로 왔는데 펫이 없으면 그냥 새 펫이 된다 — "새로고침"이 "켜기"를 겸한다
  boot();
}

function boot(): void {
  markPetRunning();
  app.on('will-quit', unmarkPetRunning);

  app.on('second-instance', (_event, argv) => {
    if (argv.includes(PET_QUIT_FLAG)) {
      app.quit();
      return;
    }
    if (argv.includes(PET_RELOAD_FLAG)) {
      const settings = loadPetSettings();
      for (const win of BrowserWindow.getAllWindows()) {
        // 설정 탭의 "위치 초기화"는 position만 비운다. 창을 실제로 옮기는 건 여기다
        if (!settings.position) moveTo(win, ...defaultPosition());
        win.webContents.send('pet:refresh');
      }
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    const win = createWindow();
    if (!IS_SMOKE) {
      roamer = startRoaming(win, {
        width: WIDTH,
        height: HEIGHT,
        isHeld: () => rendererHeld,
        onRest: () => {
          if (!win.isDestroyed()) rememberPosition(win);
        },
      });
      app.on('before-quit', () => roamer?.stop());
    }

    if (IS_SMOKE) {
      // 창 생성 + 공유 저장소 접근이 되는지 확인하고 종료
      win.webContents.once('did-finish-load', () => {
        try {
          loadPetSettings();
          getNextPendingQuestion();
          hasTodayCheckin();
          console.log('[smoke] OK: window created, shared store readable');
          setTimeout(() => app.exit(0), 500);
        } catch (error) {
          console.error(`[smoke] FAIL: ${(error as Error).message}`);
          setTimeout(() => app.exit(1), 500);
        }
      });
    }
  });

  app.on('window-all-closed', () => app.quit());
}

// ---------- 이미지 ----------
//
// 개발 모드의 펫 페이지는 http 출처라 file:// 이미지를 직접 못 읽는다. 여기서
// 읽어 data URL로 넘기면 개발·설치본 모두 같은 길을 탄다.
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function readImageDataUrl(path: string): string {
  if (!path) return '';
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mime) return '';
  try {
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    // 파일이 옮겨졌거나 지워졌다 — 기본 얼굴로 돌아간다
    return '';
  }
}

// ---------- 플립북 시트 ----------
//
// 격자로 모인 시트 한 장을 칸마다 잘라 프레임 data URL로 넘긴다. 렌더러는 낱장
// 프레임과 똑같이 넘기기만 하면 된다. nativeImage는 PNG·JPEG만 읽는다.
//
// getState는 1분마다와 말을 걸 때마다 불리므로, 같은 파일·같은 격자면 잘라 둔 것을 쓴다.
// 파일을 고쳐 저장하면 수정 시각이 바뀌어 다시 자른다. 시퀀스가 둘이라 둘을 담아 두고,
// 지금 안 쓰는 시트는 매번 비운다
let sheetCache = new Map<string, string[]>();

function sheetFrameDataUrls(path: string, columns: number, rows: number): string[] {
  let key: string;
  try {
    key = `${path}|${statSync(path).mtimeMs}|${columns}x${rows}`;
  } catch {
    return []; // 파일이 옮겨졌거나 지워졌다 — 쉬는 그림으로 돌아간다
  }
  const cached = sheetCache.get(key);
  if (cached) return cached;

  const sheet = nativeImage.createFromPath(path);
  const { width, height } = sheet.getSize();
  const cellWidth = Math.floor(width / columns);
  const cellHeight = Math.floor(height / rows);
  const frames: string[] = [];
  if (!sheet.isEmpty() && cellWidth > 0 && cellHeight > 0) {
    // 왼쪽에서 오른쪽, 위에서 아래 순서
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const cell = sheet.crop({
          x: column * cellWidth,
          y: row * cellHeight,
          width: cellWidth,
          height: cellHeight,
        });
        // 마지막 줄이 덜 찬 시트가 흔하다. 빈 칸을 넘기면 펫이 깜빡 사라진다
        if (!isBlank(cell.toBitmap())) frames.push(cell.toDataURL());
      }
    }
  }
  // 같은 파일·격자를 예전 수정 시각으로 잘라 둔 것은 이제 쓸 일이 없다
  for (const old of [...sheetCache.keys()]) {
    if (old.startsWith(`${path}|`) && old.endsWith(`|${columns}x${rows}`)) sheetCache.delete(old);
  }
  sheetCache.set(key, frames);
  return frames;
}

// BGRA든 RGBA든 알파는 네 번째 바이트다
function isBlank(bitmap: Buffer): boolean {
  for (let i = 3; i < bitmap.length; i += 4) {
    if (bitmap[i] !== 0) return false;
  }
  return true;
}

function animationFrames(animation: PetAnimation): string[] {
  if (animation.sheet) {
    return sheetFrameDataUrls(animation.sheet, animation.sheetColumns, animation.sheetRows);
  }
  // 못 읽은 프레임은 빼고 넘긴다 — 한 장이 사라졌다고 플립북이 통째로 멈추지 않게
  return animation.frames.map(readImageDataUrl).filter(Boolean);
}

function animationsState(settings: PetSettings) {
  const result = Object.fromEntries(
    PET_ANIMATION_SLOTS.map(slot => {
      const animation = settings.animations[slot];
      return [slot, { frames: animationFrames(animation), frameMs: animation.frameMs }];
    }),
  );
  // 이번에 쓰지 않은 것(바꾸기 전 시트, 예전 격자·수정 시각)은 버린다
  const used = new Set(
    PET_ANIMATION_SLOTS.map(slot => {
      const { sheet, sheetColumns, sheetRows } = settings.animations[slot];
      return `${sheet}|${sheetColumns}x${sheetRows}`;
    }),
  );
  for (const key of [...sheetCache.keys()]) {
    const [path, , grid] = key.split('|');
    if (!used.has(`${path}|${grid}`)) sheetCache.delete(key);
  }
  return result;
}

// ---------- IPC ----------
//
// 저장 함수는 실패 시 예외를 던진다. IPC 경계에서 직렬화 가능한 boolean으로
// 바꿔 렌더러가 사용자에게 표시하게 한다.

function registerIpc(): void {
  ipcMain.handle('pet:getState', () => {
    const settings = loadPetSettings();
    return {
      settings,
      imageDataUrl: readImageDataUrl(settings.image),
      animations: animationsState(settings),
      hasTodayCheckin: hasTodayCheckin(),
      question: getNextPendingQuestion(),
    };
  });

  ipcMain.handle('pet:checkin', (_event, payload) => {
    const mood = Number(payload?.mood);
    if (!isValidMood(mood)) return false;
    const note = typeof payload?.note === 'string' ? payload.note.trim() : '';
    try {
      appendCheckin({ mood, tags: [], note });
    } catch {
      return false;
    }
    appendToLog('user', `[체크인] 기분 ${mood}/10${note ? ` — ${note}` : ''}`);
    return true;
  });

  ipcMain.handle('pet:answer', (_event, payload) => {
    const { id, text, questionText } = payload ?? {};
    if (!id || !text) return false;
    // 큐 갱신이 성공한 뒤에만 로그로 환류한다 — 답변 이중 소화 방지
    try {
      resolveQuestion(id, 'answered');
    } catch {
      return false;
    }
    appendToLog('user', `[확인 질문 답변] Q: ${questionText ?? ''} A: ${text}`);
    return true;
  });

  ipcMain.handle('pet:skip', (_event, payload) => {
    const id = payload?.id;
    if (!id) return false;
    try {
      resolveQuestion(id, 'skipped');
    } catch {
      return false;
    }
    return true;
  });

  // ---------- 창 이동 ----------
  //
  // 펫은 -webkit-app-region: no-drag다 — drag 영역이면 hover·click이 렌더러까지
  // 오지 않아 상호작용을 못 한다. 대신 렌더러가 보내주는 커서 위치로 창을 직접 옮겨,
  // 잡아 끄는 동작과 만지는 동작을 같은 자리에서 둘 다 받는다.
  //
  // 좌표는 렌더러가 아니라 screen.getCursorScreenPoint()에서 읽는다. DOM의
  // screenX/screenY는 CSS 픽셀이라 디스플레이 배율이 100%가 아니면 setPosition의
  // 단위(DIP)와 어긋난다 — 커서를 조금씩 앞지르거나 뒤처지는 드래그가 된다.
  //
  // 시작 시점의 "창 좌상단 → 커서" 오프셋을 잡아두고 그걸 유지한다.
  // 매번 델타를 더하면 이벤트가 유실될 때 창이 커서에서 조금씩 밀린다.
  let dragOffset: { dx: number; dy: number } | null = null;

  ipcMain.on('pet:drag-start', event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const cursor = screen.getCursorScreenPoint();
    const [winX, winY] = win.getPosition();
    dragOffset = { dx: cursor.x - winX, dy: cursor.y - winY };
  });

  ipcMain.on('pet:drag-move', event => {
    if (!dragOffset) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const cursor = screen.getCursorScreenPoint();
    moveTo(win, cursor.x - dragOffset.dx, cursor.y - dragOffset.dy);
  });

  ipcMain.on('pet:drag-end', event => {
    dragOffset = null;
    // setPosition으로 옮긴 창은 'moved'가 오지 않을 수 있다. 끝난 자리를 여기서도 적는다
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) rememberPosition(win);
  });

  ipcMain.on('pet:click-through', (event, clickThrough) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // forward: 통과 중에도 커서 이동은 렌더러로 보내 mouseenter로 다시 잡을 수 있게 한다
    win?.setIgnoreMouseEvents(clickThrough === true, { forward: true });
  });

  ipcMain.on('pet:hold', (_event, held) => {
    rendererHeld = held !== false;
  });

  // ✕는 비활성화와 같다. 설정만 켜진 채 남으면 설정 탭이 "켜짐"이라 하고
  // 다음 앱 시작에 다시 뜬다 — 사용자가 닫은 뜻과 어긋난다
  ipcMain.on('pet:quit', () => {
    try {
      savePetSettings({ enabled: false });
    } catch {
      // 설정을 못 써도 닫히기는 해야 한다
    }
    app.quit();
  });
}

// ---------- 창 ----------

const WIDTH = 240;
const HEIGHT = 320;
const MARGIN = 16;

// 모든 창 이동은 여기로 — 배율이 있는 화면에서 setPosition은 창을 키운다(placeWindow)
function moveTo(win: BrowserWindow, x: number, y: number): void {
  placeWindow(win, x, y, WIDTH, HEIGHT);
}

function defaultPosition(): [number, number] {
  const { workArea } = screen.getPrimaryDisplay();
  return [
    workArea.x + workArea.width - WIDTH - MARGIN,
    workArea.y + workArea.height - HEIGHT - MARGIN,
  ];
}

// 기억해 둔 위치가 지금 연결된 화면 안에 있을 때만 쓴다 — 모니터를 뺀 뒤
// 보이지 않는 곳에 뜨면 사용자는 펫이 죽은 줄 안다. 어느 화면이든 작업 영역과
// 40px 이상 겹치면 잡아 끌 수 있다고 본다
function restoredPosition(settings: PetSettings): [number, number] {
  const { position } = settings;
  if (!position) return defaultPosition();
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const overlapX =
      Math.min(position.x + WIDTH, workArea.x + workArea.width) - Math.max(position.x, workArea.x);
    const overlapY =
      Math.min(position.y + HEIGHT, workArea.y + workArea.height) -
      Math.max(position.y, workArea.y);
    return overlapX >= 40 && overlapY >= 40;
  });
  return visible ? [position.x, position.y] : defaultPosition();
}

// 잡아 끈 것이든 떠돌다 멈춘 것이든 끝난 자리를 기억한다
function rememberPosition(win: BrowserWindow): void {
  const [x, y] = win.getPosition();
  try {
    savePetSettings({ position: { x, y } });
  } catch {
    // 못 적으면 다음 시작에 기본 위치로 뜰 뿐이다
  }
}

function createWindow(): BrowserWindow {
  const [x, y] = restoredPosition(loadPetSettings());

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/pet.mjs'),
      // ESM preload는 sandbox를 지원하지 않음. contextIsolation으로 격리 유지.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  // 처음에는 통과시킨다. 커서가 펫에 닿으면 렌더러가 풀어 달라고 한다
  win.setIgnoreMouseEvents(true, { forward: true });
  // 창이 우리 손 밖에서 옮겨진 경우(화면 구성 변경 등). 'moved'는 이동이 끝났을 때 한 번 온다
  // (Windows·macOS) — 'move'는 프레임마다 와서 드래그 내내 파일을 쓰게 된다
  // 떠돌기가 옮긴 건 걷는 내내 오므로 여기서 적지 않는다 — 멈출 때 한 번 적는다(petRoam.ts)
  win.on('moved', () => {
    if (!roamer?.movedByRoam()) rememberPosition(win);
  });
  // 본앱 창과 같은 렌더러 빌드의 두 번째 페이지다. 개발은 vite 서버, 배포는 out/renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    // 끝에 /가 있든 없든 pet.html이 붙게 URL 해석에 맡긴다
    const base = new URL('pet.html', process.env.ELECTRON_RENDERER_URL).toString();
    void win.loadURL(rendererUrl(base));
  } else {
    void win.loadFile(join(__dirname, '../renderer/pet.html'));
  }
  return win;
}
