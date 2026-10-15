import { errorMessage } from '../../src/utils/errors.ts';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertProviderReady,
  createSession,
  loadDotEnv,
} from '../../src/config.ts';
import { hasTodayCheckin } from '../../src/memory/checkin.ts';
import { countPendingQuestions } from '../../src/memory/questions.ts';
import { createController } from './controller.ts';
import { isPetRunning, quitPet, reloadPet, startPet } from './petLauncher.ts';
import {
  MAX_FRAMES,
  MAX_SHEET_CELLS,
  guessSheetGrid,
  isPetAnimationSlot,
  loadPetSettings,
  savePetAnimation,
  savePetSettings,
  type PetAnimation,
  type PetAnimationSlot,
  type PetSettings,
} from './petSettings.ts';
import { rendererUrl } from './rendererUrl.ts';
import { downloadUpdate, getUpdateState, installUpdate, startAutoUpdate } from './updater.ts';
import {
  applyStoredCredentials,
  installEncryptedMcpVault,
  readCredentialState,
  saveCredentials,
} from './credentials.ts';
import { listProviderModels } from '../../src/providers/models.ts';
import { classifyProviderError } from '../../src/providers/errorInfo.ts';
import type { Session } from '../../src/session/types.ts';
import { terminateOcrWorker } from '../../src/utils/ocr.ts';
import { warmWindowsDesktopPath } from '../../src/tools/write/writeFile.ts';
import { stopAllBackgroundCommands } from '../../src/tools/shell/backgroundProcesses.ts';
import { stopAllRunningCommands } from '../../src/tools/shell/runCommand.ts';
import {
  connectMcpServers,
  disconnectMcpServers,
  getMcpConfigPath,
  getMcpProblems,
  getMcpStatuses,
  reauthMcpServer,
  reconnectMcpServer,
  setMcpBrowserOpener,
} from '../../src/mcp/index.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
/** 배포 실행에서 창이 여는 렌더러 파일. 앱 화면 판별(isAppUrl)의 기준이다 */
const RENDERER_INDEX = join(__dirname, '../renderer/index.html');

/** 설정 파일이 없을 때 만들어 주는 뼈대. 다른 MCP 클라이언트와 같은 형식이다 */
const MCP_TEMPLATE = {
  mcpServers: {
    notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
  },
};

// 검증용 헤드리스 모드: 창을 숨긴 채 렌더러 로드까지 확인하고 종료함
const smokeMode = process.env.NEWBIE_APP_SMOKE === '1';

loadDotEnv(app.getAppPath());

// Windows 토스트 알림은 AppUserModelID가 있어야 앱 이름으로 뜬다.
// 없으면 알림이 "electron.app.Electron" 이름으로 나가거나 아예 무시된다
if (process.platform === 'win32') {
  // 개발 실행에서는 Electron 실행 파일을 ID로 사용해야 Windows가 토스트를 등록한다.
  // 패키징 앱은 설치 바로가기와 맞는 고정 ID를 사용한다.
  app.setAppUserModelId(app.isPackaged ? 'com.newbie.app' : process.execPath);
}

function createWindow(session: Session, startupNotice?: string) {
  // 스모크 스크린샷에서 반응형 확인용: NEWBIE_APP_SIZE=640x480
  const sizeMatch = (process.env.NEWBIE_APP_SIZE ?? '').match(/^(\d+)x(\d+)$/);
  const win = new BrowserWindow({
    width: sizeMatch ? Number(sizeMatch[1]) : 1080,
    height: sizeMatch ? Number(sizeMatch[2]) : 760,
    minWidth: 640,
    minHeight: 480,
    // 렌더러가 준비되기 전에 창을 띄우면 키보드 포커스가 어긋날 수 있어
    // ready-to-show 이후에 표시함 (스모크 모드는 계속 숨김)
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#faf8fd',
    title: 'Newbie',
    // out/main 기준 프로젝트 루트의 app/assets를 직접 참조 —
    // electron-vite가 assets를 out/으로 복사하지 않으므로 '../assets'는 빈 경로가 됨
    icon: join(__dirname, '../../app/assets/Newbie_logo_v1.png'),
    // OS 타이틀바 제거. 최소화/최대화/닫기 버튼만 오버레이로 유지
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#faf8fd',
      symbolColor: '#54524a',
      height: 34,
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // ESM preload는 sandbox를 지원하지 않음. contextIsolation으로 격리 유지.
      sandbox: false,
      // 숨김 창(스모크 모드)에서도 페인트가 밀리지 않게 함
      backgroundThrottling: !smokeMode,
    },
  });

  // 답변에 포함된 링크(remark-gfm은 맨 URL도 링크로 만든다)를 클릭하면 창
  // 자체가 그 사이트로 이동한다. 그 페이지에도 preload의 window.newbie가
  // 붙어 있어 원격 페이지가 권한 모드 변경·메시지 전송을 호출할 수 있으므로,
  // 앱 밖으로의 이동은 막고 기본 브라우저로 넘긴다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternally(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    void openExternally(url);
  });

  if (!smokeMode) {
    win.once('ready-to-show', () => win.show());
  }
  // 창 활성화 시 웹 콘텐츠에 키보드 포커스를 다시 붙임 (frameless 창 포커스 어긋남 방지)
  win.on('focus', () => win.webContents.focus());

  const controller = createController({
    session,
    emit: (event: unknown) => {
      if (!win.isDestroyed()) win.webContents.send('newbie:event', event);
    },
    // 턴이 끝나 사용자를 기다릴 때의 OS 알림 (Windows 토스트 등).
    // 그 세션을 보고 있고 창도 앞에 있으면 답이 눈앞에 있으니 알림은 소음이다
    notify: ({ body, sessionId, title, viewing }) => {
      if (smokeMode || win.isDestroyed()) return;
      if (viewing && win.isFocused()) return;
      if (!Notification.isSupported()) return;
      const notification = new Notification({ body, title });
      notification.on('click', () => {
        if (win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        // 다른 세션을 보고 있었으면 알림을 낳은 대화로 데려간다
        controller.resumeSession(sessionId);
      });
      notification.show();
    },
    quit: () => app.quit(),
    startupNotice,
  });

  // 앱 화면이 아닌 프레임이 보낸 IPC는 처리하지 않는다. 창 이동을 막는 것과 별개로,
  // preload가 붙은 채 남은 다른 페이지가 있어도 권한 변경·메시지 전송에 닿지 못하게 한다.
  // 창을 다시 만들면(macOS activate) 같은 채널을 또 등록하다 예외가 나므로 이전 것을 지우고 건다
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args) => {
      if (!isAppFrame(event)) throw new Error(`허용되지 않은 화면의 요청입니다: ${channel}`);
      return listener(event, ...args);
    });
  };
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void) => {
    ipcMain.removeAllListeners(channel);
    ipcMain.on(channel, (event, ...args) => {
      if (isAppFrame(event)) listener(event, ...args);
    });
  };

  let startupDone = false;
  handle('newbie:init', () => {
    // 렌더러 준비 후 한 번만 시작 루틴(recall/distill) 실행 — 이벤트 유실 방지
    if (!startupDone) {
      startupDone = true;
      setTimeout(() => void controller.startup(), 0);
      // 업데이트 상태는 렌더러가 떠 있어야 보이므로 여기서 시작한다. 스모크 실행은
      // 네트워크를 타지 않게 건너뛴다
      if (!smokeMode) {
        startAutoUpdate(state => {
          if (!win.isDestroyed()) win.webContents.send('newbie:event', { type: 'update', state });
        });
      }
    }
    return controller.getInitialState();
  });
  handle('newbie:preferences', () => controller.getPreferences());
  handle('newbie:save-preferences', (_event, patch) =>
    controller.savePreferences(patch),
  );
  // 자격 증명은 세션이 아니라 프로세스 환경에 얹히므로 controller를 거치지 않는다
  handle('newbie:credentials', () => readCredentialState());
  handle('newbie:save-credentials', (_event, patch) => saveCredentials(patch));
  handle('newbie:provider-ready', () => controller.isProviderReady());
  // 업데이트는 확인만 자동이고 받기·설치는 사이드바에서 눌러야 진행된다 (updater.ts)
  handle('newbie:update-state', () => getUpdateState());
  // 설정창 좌측 아래의 버전 표시
  handle('newbie:app-version', () => app.getVersion());
  handle('newbie:update-download', () => downloadUpdate());
  on('newbie:update-install', () => installUpdate());
  // 설정창의 기본 모델 목록. controller.listModels는 지금 세션의 제공자에 묶여
  // 있어서, 아직 세션에 반영되지 않은 "기본 제공자"를 물어볼 수단이 따로 필요하다
  handle('newbie:provider-models', async (_event, provider) => {
    try {
      return { models: await listProviderModels(String(provider)) };
    } catch (error) {
      // 상태 코드만 보여 주면 무엇을 고쳐야 할지 알 수 없다. 대화 오류와 같은
      // 분류를 태워 "인증 실패 — 키가 거부됐습니다"까지 말해 준다
      const info = classifyProviderError(error);
      const detail = info.detail ? ` ${info.detail}` : '';
      return { models: [], error: `${info.title}${detail}` };
    }
  });
  handle('newbie:sessions', () => controller.getSessionList());
  handle('newbie:models', () => controller.listModels());
  handle('newbie:context-breakdown', () => controller.getContextBreakdown());

  // ── MCP 탭 ─────────────────────────────────────────────────
  // 세션과 무관한 앱 전역 상태라 controller를 거치지 않는다
  const mcpState = () => ({
    configPath: getMcpConfigPath(),
    problems: getMcpProblems(),
    // 한 서버만 다시 연결하면 목록 끝으로 밀리므로(connectByName) 화면이
    // 흔들리지 않게 이름순으로 고정한다
    servers: [...getMcpStatuses()].sort((a, b) => a.name.localeCompare(b.name)),
  });
  handle('newbie:mcp-status', () => mcpState());
  // 이름이 없으면 설정을 다시 읽어 전체를 붙인다 — 파일을 고친 뒤 쓰는 경로다
  handle('newbie:mcp-reconnect', async (_event, name) => {
    if (name) await reconnectMcpServer(String(name));
    else await connectMcpServers();
    return mcpState();
  });
  handle('newbie:mcp-auth', async (_event, name) => {
    // 승인은 브라우저에서 이뤄지고 코드가 돌아올 때까지 기다린다
    await reauthMcpServer(String(name));
    return mcpState();
  });
  handle('newbie:mcp-open-config', async () => {
    const path = getMcpConfigPath();
    // 없으면 빈 파일 대신 바로 고칠 수 있는 뼈대를 만들어 준다 — 빈 화면을
    // 열어 주면 무엇을 적어야 하는지 알 길이 없다
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(MCP_TEMPLATE, null, 2)}\n`, 'utf8');
    }
    const failure = await shell.openPath(path);
    return { error: failure || undefined, path };
  });
  handle('newbie:delete-session', (_event, sessionId) =>
    controller.removeSession(sessionId),
  );
  handle('newbie:rename-session', (_event, sessionId, name) =>
    controller.renameSession(sessionId, name),
  );
  on('newbie:submit', (_event, text, images) =>
    void controller.submit(text, images),
  );
  ipcMain.on('newbie:approve', (_event, approved, sessionId) =>
    controller.resolveApproval(approved, sessionId),
  );
  on('newbie:permission-mode', (_event, mode) =>
    controller.setPermissionMode(mode),
  );
  ipcMain.on('newbie:cancel', (_event, sessionId) => controller.cancelTurn(sessionId));
  ipcMain.on('newbie:retry', (_event, sessionId) => void controller.retryLastTurn(sessionId));
  // 멈춤 안내의 "이어서 하기"와 "허용하고 이어서" (허용 목록은 컨트롤러가 쥔 것만 쓴다)
  on('newbie:continue', (_event, sessionId, approveBlocked) =>
    void controller.continueAfterStop(sessionId, approveBlocked === true),
  );
  // 안읽음 메시지의 "지금 보내기": 진행 중인 라운드를 끊고 다음 라운드에서 바로 읽게 한다
  on('newbie:interject-now', (_event, sessionId, rowId) =>
    controller.interjectNow(sessionId, typeof rowId === 'string' ? rowId : undefined),
  );
  // 막힌 도구 행의 "이 명령 허용". 행 id만 받고, 허용할 명령은 컨트롤러가 기록한 것을 쓴다
  on('newbie:allow-blocked', (_event, rowId) => {
    if (typeof rowId === 'string') void controller.allowBlockedCall(rowId);
  });
  // 화면 분할 칸 관리 — 새 대화는 만든 세션 id를 돌려줘 렌더러가 칸에 물린다
  ipcMain.handle('newbie:new-session', () => controller.newSession());
  handle('newbie:new-session-in', (_event, path: unknown) =>
    controller.newSessionIn(String(path ?? '')),
  );
  ipcMain.on('newbie:open-viewed', (_event, sessionId) =>
    controller.openViewedSession(sessionId),
  );
  ipcMain.on('newbie:close-viewed', (_event, sessionId) =>
    controller.closeViewedSession(sessionId),
  );
  ipcMain.on('newbie:set-focus', (_event, sessionId) => controller.setFocus(sessionId));
  ipcMain.on('newbie:resync-focused', () => controller.resyncFocused());
  ipcMain.handle('newbie:tab-mode', (_event, value) => controller.setTabMode(value));
  on('newbie:set-provider', (_event, name) => controller.setProvider(name));
  on('newbie:set-model', (_event, name) => controller.setModel(name));
  on('newbie:set-reasoning-effort', (_event, value) =>
    controller.setReasoningEffort(value),
  );
  on('newbie:window', (_event, action) => {
    if (action === 'close') win.close();
    if (action === 'quit') app.quit();
  });
  on('newbie:resume-session', (_event, sessionId) =>
    controller.resumeSession(sessionId),
  );
  handle('newbie:branches', () => controller.listBranches());
  handle('newbie:git-diff-summary', () => controller.getGitDiffSummary());
  handle('newbie:git-diff-files', () => controller.getGitDiffFiles());
  on('newbie:checkout-branch', (_event, name) =>
    controller.checkoutBranch(name),
  );
  ipcMain.handle('newbie:worktrees', () => controller.listWorktreeEntries());
  ipcMain.handle('newbie:worktree-add', (_event, name, base) =>
    controller.createWorktree(name, base),
  );
  ipcMain.handle('newbie:worktree-remove', (_event, name, force) =>
    controller.removeWorktreeEntry(name, force),
  );
  // 현재 테마의 창 배경·OS 버튼색. 렌더러가 테마를 바꾸면 IPC로 갱신되고,
  // 오버레이 셰이드가 걷힐 때 복원할 기본색으로도 쓰임
  let themeColors = { color: '#faf8fd', symbolColor: '#54524a' };
  on('newbie:theme-colors', (_event, colors) => {
    if (typeof colors?.color !== 'string' || typeof colors?.symbolColor !== 'string') return;
    themeColors = { color: colors.color, symbolColor: colors.symbolColor };
    win.setBackgroundColor(themeColors.color);
    try {
      win.setTitleBarOverlay({ ...themeColors, height: 34 });
    } catch {
      // titleBarOverlay 미지원 플랫폼(macOS 등)에서는 무시
    }
  });
  // 어두운 전체 화면 오버레이(이미지 확대)가 떠 있는 동안
  // OS 창 버튼 영역(titleBarOverlay)은 CSS로 덮을 수 없어 색을 직접 맞춰줌
  on('newbie:titlebar-shade', (_event, shade) => {
    try {
      win.setTitleBarOverlay(
        shade && typeof shade.color === 'string' && typeof shade.symbolColor === 'string'
          ? { color: shade.color, symbolColor: shade.symbolColor, height: 34 }
          : { ...themeColors, height: 34 },
      );
    } catch {
      // titleBarOverlay 미지원 플랫폼(macOS 등)에서는 무시
    }
  });
  // ── 펫 탭 ─────────────────────────────────────────────────
  // 펫은 별도 프로세스라 여기서는 설정 파일을 고치고 신호만 보낸다.
  // 실행 여부의 진실은 pet.json의 enabled다 — 펫의 ✕도 이 값을 끈다
  ipcMain.handle('newbie:pet-settings', () => loadPetSettings());
  ipcMain.handle('newbie:pet-set-enabled', (_event, enabled) => {
    const next = savePetSettings({ enabled: enabled === true });
    if (next.enabled) startPet();
    else quitPet();
    return next;
  });
  ipcMain.handle('newbie:pet-set-ask-questions', (_event, askQuestions) => {
    const next = savePetSettings({ askQuestions: askQuestions === true });
    if (next.enabled) reloadPet();
    return next;
  });
  // 체크인 권유·떠돌기·간격·조용한 시간은 한 채널로 받는다. 값 검증은 savePetSettings의
  // sanitize가 하므로 여기서는 허용 키만 골라낸다
  ipcMain.handle('newbie:pet-set-options', (_event, patch) => {
    const allowed: Partial<PetSettings> = {};
    if (typeof patch?.askCheckin === 'boolean') allowed.askCheckin = patch.askCheckin;
    if (typeof patch?.roam === 'boolean') allowed.roam = patch.roam;
    if (typeof patch?.intervalMinutes === 'number') allowed.intervalMinutes = patch.intervalMinutes;
    if (patch?.quietHours && typeof patch.quietHours === 'object') {
      allowed.quietHours = patch.quietHours;
    }
    const next = savePetSettings(allowed);
    if (next.enabled) reloadPet();
    return next;
  });
  // 위치는 펫이 옮겨질 때마다 스스로 적는다. 여기서는 비우고 펫에 알려 기본 자리로
  // 돌아가게만 한다
  ipcMain.handle('newbie:pet-reset-position', () => {
    const next = savePetSettings({ position: null });
    if (next.enabled) reloadPet();
    return next;
  });
  // 읽기 전용 상태. 펫이 안 보일 때 설정 탭에서 원인을 바로 알 수 있게 한다
  ipcMain.handle('newbie:pet-status', () => ({
    running: isPetRunning(),
    hasTodayCheckin: hasTodayCheckin(),
    pendingQuestions: countPendingQuestions(),
  }));
  ipcMain.handle('newbie:pet-pick-image', async () => {
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      properties: ['openFile'],
      title: '펫 이미지 선택',
    });
    const picked = result.canceled ? null : result.filePaths[0] ?? null;
    if (!picked) return loadPetSettings();
    const next = savePetSettings({ image: picked });
    if (next.enabled) reloadPet();
    return next;
  });
  // ---------- 플립북 시퀀스 (idle / walk) ----------
  //
  // 시퀀스마다 낱장이나 시트 하나를 쓴다. 한쪽을 고르면 다른 쪽은 지운다 — 둘 다 남아
  // 있으면 무엇이 보이는지 설정 탭만 보고는 알 수 없다
  const petAnimation = (slot: unknown, patch: Partial<PetAnimation>): PetSettings => {
    if (!isPetAnimationSlot(slot)) return loadPetSettings();
    const next = savePetAnimation(slot, patch);
    if (next.enabled) reloadPet();
    return next;
  };
  const slotLabel = (slot: PetAnimationSlot) => (slot === 'idle' ? '기본' : '돌아다니기');

  // 낱장은 여러 장을 한 번에 고른다. 순서는 파일 이름 순이고 숫자는 크기대로
  // 센다(walk2가 walk10보다 앞) — 대화상자가 돌려주는 순서는 고른 방식마다 달라 믿을 수 없다
  ipcMain.handle('newbie:pet-pick-frames', async (_event, slot) => {
    if (!isPetAnimationSlot(slot)) return loadPetSettings();
    const result = await dialog.showOpenDialog(win, {
      filters: [
        {
          name: '이미지',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
        },
      ],
      properties: ['openFile', 'multiSelections'],
      title: `${slotLabel(slot)} 프레임 선택 (최대 ${MAX_FRAMES}장)`,
    });
    if (result.canceled || result.filePaths.length === 0) return loadPetSettings();
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    const frames = [...result.filePaths].sort((a, b) => collator.compare(basename(a), basename(b)));
    return petAnimation(slot, { frames, sheet: '' });
  });
  // 시트는 nativeImage가 읽을 수 있는 PNG·JPEG만 받는다. TGA·EXR 같은 이펙트 원본은
  // PNG로 바꿔서 넣어야 한다
  ipcMain.handle('newbie:pet-pick-sheet', async (_event, slot) => {
    if (!isPetAnimationSlot(slot)) return loadPetSettings();
    const result = await dialog.showOpenDialog(win, {
      filters: [{ name: '시트 이미지', extensions: ['png', 'jpg', 'jpeg'] }],
      properties: ['openFile'],
      title: `${slotLabel(slot)} 시트 선택 (최대 ${MAX_SHEET_CELLS}×${MAX_SHEET_CELLS}칸)`,
    });
    const picked = result.canceled ? null : (result.filePaths[0] ?? null);
    if (!picked) return loadPetSettings();
    // 파일 이름에 격자가 적혀 있으면(Cloud02_8x8.png) 칸 수를 채워 둔다. 없으면 지금 값 그대로
    const grid = guessSheetGrid(basename(picked));
    return petAnimation(slot, {
      sheet: picked,
      frames: [],
      ...(grid ? { sheetColumns: grid.columns, sheetRows: grid.rows } : {}),
    });
  });
  // 비우기는 낱장·시트를 함께 비운다. 시퀀스가 없으면 펫 이미지(또는 기본 얼굴)로 돌아간다
  ipcMain.handle('newbie:pet-clear-animation', (_event, slot) =>
    petAnimation(slot, { frames: [], sheet: '' }),
  );
  // 숫자 값(프레임 시간, 시트 칸 수). 범위는 savePetSettings의 sanitize가 묶는다
  ipcMain.handle('newbie:pet-set-animation', (_event, slot, patch) => {
    const allowed: Partial<PetAnimation> = {};
    for (const key of ['frameMs', 'sheetColumns', 'sheetRows'] as const) {
      if (typeof patch?.[key] === 'number') allowed[key] = patch[key];
    }
    return petAnimation(slot, allowed);
  });
  ipcMain.handle('newbie:pet-clear-image', () => {
    const next = savePetSettings({ image: '' });
    if (next.enabled) reloadPet();
    return next;
  });
  // 펫이 안 떠 있으면 새로고침이 켜기를 겸하므로 설정도 켜진 것으로 맞춘다
  ipcMain.handle('newbie:pet-reload', () => {
    const next = savePetSettings({ enabled: true });
    reloadPet();
    return next;
  });
  handle('newbie:pick-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      // 지정하지 않으면 Windows가 제 기본값(다운로드 등)에서 연다.
      // 지금 작업 폴더에서 시작해야 옆 폴더로 옮기는 흔한 경우가 빠르다
      defaultPath: process.cwd(),
      properties: ['openDirectory'],
      title: '작업 폴더 선택',
    });
    const picked = result.canceled ? null : result.filePaths[0] ?? null;
    if (picked) controller.changeWorkingDirectory(picked);
    return picked;
  });

  // 창은 ready-to-show 이후에야 보이므로, 로드가 실패하면 아무것도 뜨지 않고
  // 조용히 멈춘 것처럼 보인다. 실제로 개발 서버 포트에 죽은 소켓이 남아
  // 렌더러를 못 불러오는데 창도 오류도 없는 상태를 겪었다. 실패를 눈에 보이게 한다
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (code === -3) return; // 사용자가 중단시킨 로드(ERR_ABORTED)는 정상 흐름
    if (!smokeMode) win.show();
    dialog.showErrorBox(
      '화면을 불러오지 못했습니다',
      [`${description} (${code})`, url, '', '개발 서버가 떠 있는지 확인하세요.'].join('\n'),
    );
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(rendererUrl(process.env.ELECTRON_RENDERER_URL));
  } else {
    void win.loadFile(RENDERER_INDEX);
  }

  if (smokeMode) {
    void import('./smoke.ts').then(({ attachSmokeHarness }) =>
      attachSmokeHarness(win, () => app.quit()),
    );
  }

  return win;
}

app.whenReady().then(() => {
  // safeStorage는 앱 준비 이후에만 쓸 수 있다. 저장된 키를 환경에 먼저 얹어야
  // createSession의 시작 제공자 검사가 설정창에서 넣은 값을 보게 된다
  applyStoredCredentials();
  // MCP OAuth 토큰도 같은 암호화 저장소로 옮긴다. connectMcpServers보다 먼저여야
  // 한다 — 연결이 시작되면 저장소를 읽는다
  installEncryptedMcpVault();
  moveOutOfInstallDir();

  let session: Session;
  try {
    session = createSession({});
  } catch (error) {
    dialog.showErrorBox('Newbie 시작 실패', String(errorMessage(error)));
    app.quit();
    return;
  }

  // 키가 없다고 앱을 닫아 버리면 정작 키를 넣을 설정창에 갈 방법이 없다.
  // 시작은 시키고, 왜 대화가 안 되는지만 홈 화면에 남긴다
  let startupNotice: string | undefined;
  try {
    assertProviderReady(session);
  } catch (error) {
    startupNotice = `${errorMessage(error)} 설정 > 제공자에서 키를 입력하세요.`;
  }

  // 첫 파일 쓰기에서 메인 스레드가 멈추지 않도록 바탕화면 경로를 미리 구해둠
  void warmWindowsDesktopPath();
  // OAuth 승인 URL은 앱 창이 아니라 기본 브라우저에서 열어야 로그인 세션을 재사용함
  setMcpBrowserOpener(openExternally);
  // 서버 연결은 네트워크·프로세스 기동을 기다리므로 창을 막지 않고 뒤에서 진행함.
  // 스모크 실행은 로컬 mcp.json 상태에 따라 결과가 달라지지 않게 건너뜀
  if (!smokeMode) void connectMcpServers();
  createWindow(session, startupNotice);
  // 펫은 detached 프로세스라 본앱을 닫아도 남는다. 이미 떠 있으면 락에 막혀 중복되지 않는다
  if (!smokeMode && loadPetSettings().enabled) startPet();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(session, startupNotice);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  terminateOcrWorker();
  // stdio 서버는 자식 프로세스라 닫지 않으면 앱이 꺼진 뒤에도 남는다
  void disconnectMcpServers();
  // start_process로 띄운 개발 서버도 같은 이유로 정리한다 (포트가 물린 채 남는다)
  stopAllBackgroundCommands();
  // 실행 중이던 run_command의 자식도 정리 — 셸만 죽으면 실제 명령이 고아로 남는다
  stopAllRunningCommands();
});

/**
 * 설치본의 시작 작업 폴더를 설치 폴더 밖으로 옮긴다.
 *
 * 설치 프로그램이 만드는 바로가기는 시작 폴더가 앱 설치 위치다. 그대로 두면
 * 에이전트의 작업 폴더가 프로그램이 깔린 폴더가 되어, 파일 쓰기 도구가 제거
 * 프로그램이 관리하는 폴더에 파일을 만들고 작업 폴더 칩에도 설치 폴더 이름이
 * 뜬다. 개발 실행(리포에서 시작)은 건드리지 않는다.
 */
function moveOutOfInstallDir(): void {
  if (!app.isPackaged) return;
  if (resolve(process.cwd()) !== dirname(app.getPath('exe'))) return;

  for (const name of ['documents', 'home'] as const) {
    try {
      process.chdir(app.getPath(name));
      return;
    } catch {
      // 문서 폴더가 리다이렉션돼 없는 환경이 있다 — 홈으로 넘어간다
    }
  }
}

// 앱 자신의 화면인지 판별함. 개발 모드는 vite 개발 서버, 배포는 렌더러 index.html 파일 하나.
// file: 전체를 허용하면 로컬 HTML로 이동했을 때 그 페이지가 window.newbie를 쥔다
function isAppUrl(url: string): boolean {
  try {
    const target = new URL(url);
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
      // 창은 rendererUrl()이 localhost를 127.0.0.1로 바꾼 주소로 열린다
      return (
        target.origin === new URL(rendererUrl(devUrl)).origin ||
        target.origin === new URL(devUrl).origin
      );
    }
    if (target.protocol !== 'file:') return false;
    return comparablePath(fileURLToPath(target)) === comparablePath(RENDERER_INDEX);
  } catch {
    return false;
  }
}

// Windows 경로는 대소문자와 구분자 표기가 달라도 같은 파일이다
function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isAppFrame(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url;
  return typeof url === 'string' && isAppUrl(url);
}

// 외부 링크는 기본 브라우저로. http/https만 넘겨 file:·외부 프로그램을 여는
// 스킴(예: ms-msdt:)이 클릭 한 번으로 실행되는 것을 막는다
async function openExternally(url: string): Promise<void> {
  try {
    const { protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return;
    await shell.openExternal(url);
  } catch {
    // 잘못된 URL은 무시
  }
}
