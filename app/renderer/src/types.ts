export type TranscriptRow = {
  /** 보낸/완성된 시각 (ISO). "n분 전" 표시용. 스트리밍 중인 답변은 없음 */
  at?: string;
  /** 사용자 행: 모델이 읽은 시각. 없으면 아직 안 읽음 (작업 중 끼어든 메시지) */
  readAt?: string;
  id: string;
  role:
    | 'assistant'
    | 'compact'
    | 'error'
    | 'stop'
    | 'system'
    | 'tool'
    | 'user';
  content: string;
  /** true면 홈 화면(HomeHero)에만 표시 — 시작 루틴(recall·distill) 알림용 */
  homeOnly?: boolean;
  /** 사용자 메시지에 첨부된 이미지 (data URL) */
  images?: string[];
  input?: Record<string, string>;
  name?: string;
  /** 보조 에이전트 안의 도구 행: 그것을 띄운 spawn_agent 행의 id (그 아래 중첩 표시) */
  parentId?: string;
  /** 오류 행의 분류. 화면이 어떤 조치 버튼을 낼지 정하는 근거 */
  errorKind?: string;
  /** 오류 행에서 제공자가 실제로 보낸 문장 (접어 둠) */
  errorDetail?: string;
  /** assistant 행의 추론 요약 (본문 위 접이식 "생각" 블록) */
  reasoning?: string;
  result?: string;
  target?: string;
  toolStatus?: 'blocked' | 'done' | 'error' | 'running';
  /** 막힌 도구 행: "이 명령 허용"을 붙일 수 있다 (실행 중에 막힌 것만) */
  allowable?: boolean;
  /** 막힌 도구 행: 사용자가 이 명령을 허용했다 */
  allowed?: boolean;
  /** compact 행: 이력 압축 줄의 상태 ("압축 중..." → "압축 완료") */
  compact?: {
    /** 모델이 받는 압축문 전체 (요약과 요청 원문 목록) */
    brief?: string;
    error?: string;
    freedTokens?: number;
    state: 'done' | 'failed' | 'running' | 'skipped';
    trigger: 'auto' | 'manual';
  };
  /** stop 행: 턴이 답 없이 멈춘 이유. 화면이 사유에 맞는 버튼을 붙인다 */
  stop?: {
    blocked?: { command: string; name: string; reason: string }[];
    cause: 'classifier_down' | 'context' | 'denied' | 'no_progress';
  };
};

export type AgentStatus = {
  label: string;
  startedAt: number;
};

export type ApprovalRequest = {
  label: string;
  /** 실제로 실행·기록될 내용 (명령 전문, 수정 전후 텍스트 등) */
  detail?: string;
  /** 권한 모드가 아니라 입력 자체 때문에 승인을 받는 경우의 사유 */
  reason?: string | null;
};

export type CommandEntry = {
  command: string;
  completion?: string;
  description: string;
};

export type PermissionModeEntry = {
  value: string;
  label: string;
};

export type ReasoningEffortEntry = {
  value: string;
  label: string;
  hint: string;
};

export type InitialState = {
  commands: CommandEntry[];
  mode: string;
  model: string;
  permissionMode: string;
  permissionModes: PermissionModeEntry[];
  provider: string;
  /** 지금 제공자에 키·주소가 있어 대화할 수 있는가. false면 홈 화면에 연결 안내를 띄운다 */
  providerReady: boolean;
  providers: string[];
  /** 현재 추론 강도. 강도가 의미 없는 제공자·모델이면 null (칩 숨김) */
  reasoningEffort: string | null;
  reasoningEfforts: ReasoningEffortEntry[];
  rows: TranscriptRow[];
  sessionId: string;
  /** 앱을 켰을 때 열려 있는 탭 */
  tabMode: TabMode;
  /** 마지막 API 호출의 실측값. 첫 응답 전에는 null (게이지 숨김) */
  tokens: TokenUsage | null;
  version: string;
  workspace: WorkspaceInfo;
};

/** 작업 공간 정보 (워크스페이스 칩·홈 화면용). branch는 git 저장소가 아니면 null */
export type WorkspaceInfo = {
  branch: string | null;
  folder: string;
  /** 작업 폴더 전체 경로. 칩에는 이름만 보이므로 툴팁에 쓴다 */
  path: string;
};

export type BranchListResult = {
  branches: string[];
  current: string | null;
  error?: string;
};

/** 워크트리 칩 목록의 한 항목 */
export type WorktreeEntry = {
  path: string;
  branch: string | null;
  isMain: boolean;
  /** .newbie/worktrees/ 아래 폴더일 때만 채워짐 — 제거 버튼이 넘길 이름 */
  managedName: string | null;
};

export type WorktreeListResult = {
  worktrees: WorktreeEntry[];
  error?: string;
};

export type WorktreeActionResult = {
  ok: boolean;
  message: string;
};

export type GitDiffStatus = 'added' | 'deleted' | 'modified' | 'untracked';

export type GitDiffFileStat = {
  path: string;
  insertions: number;
  deletions: number;
  status: GitDiffStatus;
};

/** main(merge-base) 대비 변경 통계. git 저장소가 아니면 null */
export type GitDiffSummary = {
  base: string;
  insertions: number;
  deletions: number;
  files: GitDiffFileStat[];
};

export type GitDiffLine = { kind: 'add' | 'context' | 'del'; text: string };
export type GitDiffHunk = { header: string; lines: GitDiffLine[] };
export type GitFileDiff = {
  path: string;
  status: GitDiffStatus;
  hunks: GitDiffHunk[];
  truncated?: boolean;
};

export type TokenUsage = {
  /** 입력 토큰 중 캐시에서 읽은 몫 (main의 getContextUsage가 보내는 값) */
  cached: number;
  /** 마지막 라운드의 입력 토큰 전체 (캐시 포함). used - input이 출력이다 */
  input: number;
  used: number;
  window: number;
};

export type SessionSummary = {
  created: string;
  firstPrompt: string;
  /** 어느 탭의 대화인지. 사이드바가 탭별로 목록을 나눈다 */
  mode: TabMode;
  modified: string;
  name: string;
  projectName: string;
  projectPath: string;
  sessionId: string;
};

// 화면 분할: per-session(칸별) 이벤트에는 sessionId가 실려 온다. 렌더러가 어느
// 칸의 이벤트인지 구분해 그 칸의 상태만 갱신한다. 전역 이벤트(alert·notice·
// tokens·workspace)에는 없다. 분할이 없을 때도 sessionId는 실려
// 오지만 칸이 하나뿐이라 라우팅 결과가 같다
/** 사이드바 업데이트 줄이 그리는 상태. app/main/updater.ts와 같은 모양 */
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

export type NewbieEvent =
  | { type: 'approval'; request: ApprovalRequest | null; sessionId?: string }
  | { type: 'busy'; value: boolean; sessionId?: string }
  | { type: 'mode'; value: string; sessionId?: string }
  /** 대화와 무관한 오류. 대화 기록을 더럽히지 않도록 팝업으로 띄운다 */
  | { type: 'alert'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'permission-mode'; value: string; sessionId?: string }
  | { type: 'row:append'; row: TranscriptRow; sessionId?: string }
  | { type: 'row:patch'; id: string; patch: Partial<TranscriptRow>; sessionId?: string }
  | { type: 'row:update'; id: string; content: string; role?: string; sessionId?: string }
  | { type: 'rows:set'; rows: TranscriptRow[]; sessionId?: string }
  | {
      type: 'session-meta';
      model: string;
      provider: string;
      reasoningEffort: string | null;
      sessionId: string;
      tokens: TokenUsage | null;
    }
  /** 세션 목록이 바뀌었다 (자동 제목 등). 턴 종료·이름 변경·삭제는 각자 목록을 다시 받는다 */
  | { type: 'sessions-changed' }
  | { type: 'status'; status: AgentStatus | null; sessionId?: string }
  | { type: 'tokens'; tokens: TokenUsage | null }
  | { type: 'turn-tokens'; used: number | null; sessionId?: string }
  | { type: 'update'; state: UpdateState }
  | { type: 'workspace'; workspace: WorkspaceInfo };

/** 컨텍스트 창을 무엇이 차지하는지. 잴 수 없는 제공자는 supported=false */
export type ContextBreakdownResult = {
  supported: boolean;
  parts?: { system: number; tools: number; mcpTools: number; messages: number };
  /** supported=false인 이유 — 턴 없음 / 제공자 미지원 / 측정 실패 */
  reason?: 'no-turn' | 'unsupported' | 'failed';
  provider?: string;
  error?: string;
};

/** 설정창 > MCP 탭의 서버 한 줄 (main의 McpServerStatus 그대로) */
export type McpServerRow = {
  name: string;
  state: 'connected' | 'disabled' | 'failed' | 'needs-auth';
  type: 'http' | 'sse' | 'stdio';
  target: string;
  toolCount: number;
  /** 도구가 무거워 지연 로딩으로 돌린 서버인지 */
  deferred?: boolean;
  error?: string;
};

export type McpState = {
  configPath: string;
  /** 설정 파일 자체의 문제 (형식 오류 등) */
  problems: string[];
  servers: McpServerRow[];
};

export type PetAnimationSlot = 'idle' | 'walk';

/** 플립북 시퀀스 하나 (main의 PetAnimation 그대로). 시트가 있으면 낱장 대신 시트 */
export type PetAnimation = {
  frames: string[];
  sheet: string;
  sheetColumns: number;
  sheetRows: number;
  frameMs: number;
};

/** 설정창 > 펫 탭 (main의 PetSettings 그대로) */
export type PetSettings = {
  enabled: boolean;
  askQuestions: boolean;
  /** 오늘 체크인이 없을 때 기분을 물을지 */
  askCheckin: boolean;
  intervalMinutes: number;
  /** 시작과 끝이 같으면 조용한 시간 없음 */
  quietHours: { start: string; end: string };
  /** 사용자가 고른 이미지의 절대 경로. 비면 기본 얼굴 */
  image: string;
  /** 스스로 화면을 옆으로 걸어 다닐지 */
  roam: boolean;
  /** 플립북 시퀀스. idle은 늘, walk는 떠돌기로 걷는 동안만 넘긴다 */
  animations: Record<PetAnimationSlot, PetAnimation>;
  /** 마지막으로 옮겨 둔 창 위치. null이면 우하단 기본 위치 */
  position: { x: number; y: number } | null;
};

/** 설정창 > 펫 탭의 읽기 전용 상태 */
export type PetStatus = {
  running: boolean;
  hasTodayCheckin: boolean;
  pendingQuestions: number;
};

export type ModelListResult = {
  models: string[];
  error?: string;
};

/** 상단 탭. 채팅은 대화 전용, 코딩은 전체 도구 */
export type TabMode = 'agent' | 'chat';

/** 설정창에서 입력해 시스템 프롬프트로 들어가는 값 */
export type Preferences = {
  userName: string;
  agentName: string;
  instructions: string;
};

/** 설정창 > 제공자 탭의 한 줄. 비밀 항목의 실제 값은 여기 담기지 않는다 */
export type CredentialField = {
  key: string;
  secret: boolean;
  /** 비밀 항목은 마스킹된 표시용 문자열, 나머지는 실제 값 */
  value: string;
  present: boolean;
  /** .env나 환경 변수가 이미 잡고 있어 저장값이 무시되는 상태 */
  overriddenByEnv: boolean;
};

export type CredentialState = {
  /** OS 자격 증명 저장소를 쓸 수 있는지. false면 저장이 거부된다 */
  available: boolean;
  fields: CredentialField[];
  /** 사용자가 만든 비밀값 (MCP 설정의 ${VAR}에 쓴다). 값은 마스킹만 온다 */
  custom: { name: string; masked: string }[];
  /** 사용자 정의 이름에 붙는 접두사 */
  customPrefix: string;
  /** 기본 제공자 선택지 (main의 PROVIDERS) */
  providers: string[];
};

export type NewbieBridge = {
  init(): Promise<InitialState>;
  sessions(): Promise<SessionSummary[]>;
  preferences(): Promise<Preferences>;
  savePreferences(patch: Partial<Preferences>): Promise<Preferences>;
  credentials(): Promise<CredentialState>;
  saveCredentials(patch: Record<string, string>): Promise<CredentialState>;
  providerReady(): Promise<boolean>;
  /** 설정창 전용 — 지금 세션이 아니라 지정한 제공자의 모델 목록 */
  providerModels(provider: string): Promise<ModelListResult>;
  models(): Promise<ModelListResult>;
  /** 컨텍스트 구성별 측정. 지원하지 않는 제공자면 supported=false */
  contextBreakdown(): Promise<ContextBreakdownResult>;
  mcpStatus(): Promise<McpState>;
  /** 이름을 주면 그 서버만, 없으면 설정을 다시 읽어 전체를 다시 연결한다 */
  mcpReconnect(name?: string): Promise<McpState>;
  /** 저장된 승인을 지우고 브라우저 승인을 다시 받는다 */
  mcpAuth(name: string): Promise<McpState>;
  /** 설정 파일을 기본 편집기로 연다. 없으면 예시를 만들어서 연다 */
  mcpOpenConfig(): Promise<{ path: string; error?: string }>;
  submit(text: string, images?: string[]): void;
  /** 파일 선택창·드롭으로 받은 File의 절대 경로. 경로가 없는 File(붙여넣기)은 빈 문자열 */
  pathForFile(file: File): string;
  /** sessionId를 주면 그 칸의 승인을, 없으면 포커스된 칸의 승인을 처리한다 */
  approve(approved: boolean, sessionId?: string): void;
  setPermissionMode(mode: string): void;
  setProvider(name: string): void;
  setModel(name: string): void;
  setReasoningEffort(value: string): void;
  cancel(sessionId?: string): void;
  /** 실패한 턴을 같은 입력으로 다시 보낸다 (sessionId로 칸 지정 가능) */
  retryLastTurn(sessionId?: string): void;
  /**
   * 멈춤 안내의 버튼. approveBlocked면 그 턴에서 막혔던 명령을 허용하고 이어서,
   * 아니면 그냥 이어서 하라고 보낸다
   */
  continueAfterStop(sessionId?: string, approveBlocked?: boolean): void;
  /** 작업 중에 보낸(안읽음) 메시지를 지금 라운드를 끊고 바로 읽게 한다 */
  interjectNow(rowId: string, sessionId?: string): void;
  /** 막힌 도구 행의 명령을 허용하고 모델에게 다시 실행하라고 알린다 (행 id만 보낸다) */
  allowBlockedCall(rowId: string): void;
  /** 새 대화를 만들고 그 세션 id를 돌려준다 — 렌더러가 어느 칸에 물릴지 정한다 */
  newSession(): Promise<string>;
  newSessionIn(path: string): Promise<string>;
  /** 화면 분할: 칸에 세션을 추가로 띄운다 (포커스는 그대로) */
  openViewedSession(sessionId: string): void;
  /** 화면 분할: 칸에서 세션을 내린다 (돌고 있는 턴은 백그라운드로 계속) */
  closeViewedSession(sessionId: string): void;
  /** 화면 분할: 포커스(전역 UI·설정·입력이 향하는 칸)를 옮긴다 */
  setFocus(sessionId: string): void;
  /** 포커스된 칸을 새 세션에 묶은 뒤, 그 세션 상태를 다시 받는다 */
  resyncFocused(): void;
  /** 탭 전환 — 새 대화를 열고 그 세션 id를 돌려준다 */
  setTabMode(mode: TabMode): Promise<string>;
  resumeSession(sessionId: string): void;
  branches(): Promise<BranchListResult>;
  gitDiffSummary(): Promise<GitDiffSummary | null>;
  gitDiffFiles(): Promise<GitFileDiff[] | null>;
  checkoutBranch(name: string): void;
  worktrees(): Promise<WorktreeListResult>;
  worktreeAdd(name: string, base?: string): Promise<WorktreeActionResult>;
  worktreeRemove(name: string, force: boolean): Promise<WorktreeActionResult>;
  pickFolder(): Promise<string | null>;
  petSettings(): Promise<PetSettings>;
  /** 켜면 펫 프로세스를 띄우고, 끄면 떠 있는 펫을 종료한다 */
  petSetEnabled(enabled: boolean): Promise<PetSettings>;
  petSetAskQuestions(askQuestions: boolean): Promise<PetSettings>;
  /** 체크인 권유·떠돌기·간격·조용한 시간. 넘긴 키만 바뀐다 */
  petSetOptions(
    patch: Partial<
      Pick<PetSettings, 'askCheckin' | 'roam' | 'intervalMinutes' | 'quietHours'>
    >,
  ): Promise<PetSettings>;
  /** 기억한 창 위치를 지우고 떠 있는 펫을 기본 자리로 되돌린다 */
  petResetPosition(): Promise<PetSettings>;
  petStatus(): Promise<PetStatus>;
  /** 파일 대화상자로 이미지를 고른다. 취소하면 설정이 그대로 돌아온다 */
  petPickImage(): Promise<PetSettings>;
  petClearImage(): Promise<PetSettings>;
  /** 시퀀스에 낱장 여러 장을 고른다. 파일 이름 순. 시트는 지운다 */
  petPickFrames(slot: PetAnimationSlot): Promise<PetSettings>;
  /** 시퀀스에 격자 시트 한 장을 고른다. 파일 이름에 8x8처럼 있으면 칸 수도 채운다. 낱장은 지운다 */
  petPickSheet(slot: PetAnimationSlot): Promise<PetSettings>;
  /** 시퀀스의 낱장·시트를 모두 비운다 */
  petClearAnimation(slot: PetAnimationSlot): Promise<PetSettings>;
  /** 프레임 시간·시트 칸 수. 넘긴 키만 바뀐다 */
  petSetAnimation(
    slot: PetAnimationSlot,
    patch: Partial<Pick<PetAnimation, 'frameMs' | 'sheetColumns' | 'sheetRows'>>,
  ): Promise<PetSettings>;
  /** 떠 있는 펫이 설정·이미지를 다시 읽는다. 없으면 새로 띄운다 */
  petReload(): Promise<PetSettings>;
  setTitlebarShade(shade: { color: string; symbolColor: string } | null): void;
  setThemeColors(colors: { color: string; symbolColor: string }): void;
  deleteSession(sessionId: string): Promise<SessionSummary[]>;
  renameSession(sessionId: string, name: string): Promise<SessionSummary[]>;
  windowControl(action: 'close' | 'quit'): void;
  /** 켤 때 확인해 둔 업데이트 상태. 이후 변화는 'update' 이벤트로 온다 */
  updateState(): Promise<UpdateState>;
  /** 지금 실행 중인 앱의 버전 (package.json) */
  appVersion(): Promise<string>;
  /** 받기 시작. 받을 것이 없으면 지금 상태가 그대로 돌아온다 */
  updateDownload(): Promise<UpdateState>;
  /** 받아 둔 업데이트를 설치하고 다시 시작한다 */
  updateInstall(): void;
  onEvent(callback: (event: NewbieEvent) => void): () => void;
};

declare global {
  interface Window {
    newbie: NewbieBridge;
  }
}
