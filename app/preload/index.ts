import { contextBridge, ipcRenderer, webUtils } from 'electron';

// 렌더러에 노출하는 최소 API. 채널을 고정해 임의 IPC 접근을 막음.
contextBridge.exposeInMainWorld('newbie', {
  init: () => ipcRenderer.invoke('newbie:init'),
  sessions: () => ipcRenderer.invoke('newbie:sessions'),
  preferences: () => ipcRenderer.invoke('newbie:preferences'),
  savePreferences: (patch: Record<string, string>) =>
    ipcRenderer.invoke('newbie:save-preferences', patch),
  credentials: () => ipcRenderer.invoke('newbie:credentials'),
  saveCredentials: (patch: Record<string, string>) =>
    ipcRenderer.invoke('newbie:save-credentials', patch),
  providerReady: () => ipcRenderer.invoke('newbie:provider-ready'),
  providerModels: (provider: string) =>
    ipcRenderer.invoke('newbie:provider-models', provider),
  models: () => ipcRenderer.invoke('newbie:models'),
  contextBreakdown: () => ipcRenderer.invoke('newbie:context-breakdown'),
  mcpStatus: () => ipcRenderer.invoke('newbie:mcp-status'),
  mcpReconnect: (name?: string) => ipcRenderer.invoke('newbie:mcp-reconnect', name),
  mcpAuth: (name: string) => ipcRenderer.invoke('newbie:mcp-auth', name),
  mcpOpenConfig: () => ipcRenderer.invoke('newbie:mcp-open-config'),
  submit: (text: string, images?: string[]) =>
    ipcRenderer.send('newbie:submit', text, images ?? []),
  // 렌더러의 File에는 경로가 없다(Electron 32에서 File.path 제거). 문서 첨부는
  // 내용이 아니라 경로를 모델에 넘기므로 preload에서 경로를 꺼내 준다
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  // sessionId를 주면 그 칸의 턴을 겨냥한다. 없으면 포커스된 칸
  approve: (approved: boolean, sessionId?: string) =>
    ipcRenderer.send('newbie:approve', approved, sessionId),
  setPermissionMode: (mode: string) =>
    ipcRenderer.send('newbie:permission-mode', mode),
  cancel: (sessionId?: string) => ipcRenderer.send('newbie:cancel', sessionId),
  retryLastTurn: (sessionId?: string) => ipcRenderer.send('newbie:retry', sessionId),
  continueAfterStop: (sessionId?: string, approveBlocked?: boolean) =>
    ipcRenderer.send('newbie:continue', sessionId, approveBlocked === true),
  interjectNow: (rowId: string, sessionId?: string) =>
    ipcRenderer.send('newbie:interject-now', sessionId, rowId),
  allowBlockedCall: (rowId: string) => ipcRenderer.send('newbie:allow-blocked', rowId),
  // 새 대화를 만들고 그 세션 id를 돌려준다 — 렌더러가 어느 칸에 물릴지 정한다
  newSession: (): Promise<string> => ipcRenderer.invoke('newbie:new-session'),
  // 사이드바 프로젝트 그룹의 +: 그 폴더에서 새 대화
  newSessionIn: (path: string): Promise<string> =>
    ipcRenderer.invoke('newbie:new-session-in', path),
  // 화면 분할: 칸에 세션을 추가로 띄우기 / 칸에서 내리기 / 포커스 옮기기
  openViewedSession: (sessionId: string) =>
    ipcRenderer.send('newbie:open-viewed', sessionId),
  closeViewedSession: (sessionId: string) =>
    ipcRenderer.send('newbie:close-viewed', sessionId),
  setFocus: (sessionId: string) => ipcRenderer.send('newbie:set-focus', sessionId),
  // 포커스된 칸이 새 세션에 묶인 뒤 그 세션 상태를 다시 받는다 (탭 전환·새 대화용)
  resyncFocused: () => ipcRenderer.send('newbie:resync-focused'),
  // 탭 전환은 새 대화를 열고 그 세션 id를 돌려준다 — 렌더러가 칸에 물린다
  setTabMode: (mode: string): Promise<string> => ipcRenderer.invoke('newbie:tab-mode', mode),
  setProvider: (name: string) => ipcRenderer.send('newbie:set-provider', name),
  setModel: (name: string) => ipcRenderer.send('newbie:set-model', name),
  setReasoningEffort: (value: string) =>
    ipcRenderer.send('newbie:set-reasoning-effort', value),
  resumeSession: (sessionId: string) =>
    ipcRenderer.send('newbie:resume-session', sessionId),
  branches: () => ipcRenderer.invoke('newbie:branches'),
  gitDiffSummary: () => ipcRenderer.invoke('newbie:git-diff-summary'),
  gitDiffFiles: () => ipcRenderer.invoke('newbie:git-diff-files'),
  checkoutBranch: (name: string) => ipcRenderer.send('newbie:checkout-branch', name),
  worktrees: () => ipcRenderer.invoke('newbie:worktrees'),
  worktreeAdd: (name: string, base?: string) =>
    ipcRenderer.invoke('newbie:worktree-add', name, base),
  worktreeRemove: (name: string, force: boolean) =>
    ipcRenderer.invoke('newbie:worktree-remove', name, force),
  pickFolder: () => ipcRenderer.invoke('newbie:pick-folder'),
  petSettings: () => ipcRenderer.invoke('newbie:pet-settings'),
  petSetEnabled: (enabled: boolean) => ipcRenderer.invoke('newbie:pet-set-enabled', enabled),
  petSetAskQuestions: (askQuestions: boolean) =>
    ipcRenderer.invoke('newbie:pet-set-ask-questions', askQuestions),
  petSetOptions: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('newbie:pet-set-options', patch),
  petResetPosition: () => ipcRenderer.invoke('newbie:pet-reset-position'),
  petStatus: () => ipcRenderer.invoke('newbie:pet-status'),
  petPickImage: () => ipcRenderer.invoke('newbie:pet-pick-image'),
  petClearImage: () => ipcRenderer.invoke('newbie:pet-clear-image'),
  petPickFrames: (slot: string) => ipcRenderer.invoke('newbie:pet-pick-frames', slot),
  petPickSheet: (slot: string) => ipcRenderer.invoke('newbie:pet-pick-sheet', slot),
  petClearAnimation: (slot: string) => ipcRenderer.invoke('newbie:pet-clear-animation', slot),
  petSetAnimation: (slot: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke('newbie:pet-set-animation', slot, patch),
  petReload: () => ipcRenderer.invoke('newbie:pet-reload'),
  setTitlebarShade: (shade: { color: string; symbolColor: string } | null) =>
    ipcRenderer.send('newbie:titlebar-shade', shade),
  setThemeColors: (colors: { color: string; symbolColor: string }) =>
    ipcRenderer.send('newbie:theme-colors', colors),
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke('newbie:delete-session', sessionId),
  renameSession: (sessionId: string, name: string) =>
    ipcRenderer.invoke('newbie:rename-session', sessionId, name),
  windowControl: (action: string) => ipcRenderer.send('newbie:window', action),
  updateState: () => ipcRenderer.invoke('newbie:update-state'),
  appVersion: (): Promise<string> => ipcRenderer.invoke('newbie:app-version'),
  updateDownload: () => ipcRenderer.invoke('newbie:update-download'),
  updateInstall: () => ipcRenderer.send('newbie:update-install'),
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on('newbie:event', listener);
    return () => ipcRenderer.removeListener('newbie:event', listener);
  },
});
