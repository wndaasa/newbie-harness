import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { runAgentLoop, stopSummary } from '../../src/agent/loop.ts';
import {
  KEEP_RECENT_TOOL_ROUNDS,
  applyCompactionCheckpoint,
  compactMessages,
  measureHistoryTokens,
} from '../../src/agent/compact.ts';
import { runInWorkdir } from '../../src/agent/workdir.ts';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  decideToolPermission,
  defaultPermissionMode,
} from '../../src/agent/permissions.ts';
import { formatSlashCommandHelp, SLASH_COMMANDS } from '../../src/commands/registry.ts';
import { runSlashCommand } from '../../src/commands/router.ts';
import {
  APP_VERSION,
  assertProviderReady,
  buildSystemPrompt,
  buildTurnEnvContext,
  getDefaultModel,
  normalizeProvider,
  PROVIDERS,
} from '../../src/config.ts';
import {
  readPreferences,
  sanitizePreferences,
  writePreferences,
} from '../../src/settings/preferences.ts';
import type { Preferences } from '../../src/settings/preferences.ts';
import {
  countUnprocessedLogFiles,
  distillUnprocessedLogs,
  isCorrectionMessage,
} from '../../src/memory/distill.ts';
import { appendToLog } from '../../src/memory/logger.ts';
import { getRecallSummary } from '../../src/memory/recall.ts';
import {
  fetchContextWindow,
  resolveContextWindow,
} from '../../src/providers/contextWindow.ts';
import {
  checkoutGitBranch,
  getCurrentGitBranch,
  listGitBranches,
} from '../../src/tools/git/git.ts';
import { fetchGitDiffSummary, fetchGitFileDiffs } from '../../src/tools/git/gitDiff.ts';
import {
  approvalConfirm,
  clearLoadedTools,
  getAnthropicTools,
  getOpenAITools,
  setToolMode,
} from '../../src/tools/registry.ts';
import {
  addWorktree,
  getWorktrees,
  removeWorktree,
} from '../../src/tools/worktree/worktree.ts';
import {
  measureBreakdown,
  supportsBreakdown,
} from '../../src/providers/contextBreakdown.ts';
import type { TurnInputs } from '../../src/providers/contextBreakdown.ts';
import { classifyProviderError } from '../../src/providers/errorInfo.ts';
import { listProviderModels } from '../../src/providers/models.ts';
import { isReasoningModel } from '../../src/providers/openai.ts';
import type { AgentReport, BlockedCall, Interjection } from '../../src/agent/loop.ts';
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_OPTIONS,
  isReasoningEffort,
} from '../../src/providers/openaiResponses.ts';
import {
  applyLoadedSession,
  createSessionPersistence,
  deleteSession as deleteSessionFile,
  listAllSessions,
  loadSessionById,
  recordSessionConfig,
  recordSessionCompaction,
  recordSessionMessages,
  recordSessionMode,
  recordSessionUsage,
  sessionConfigOf,
  recordSessionRow,
  renameSession as renameSessionFile,
  repointSessionProject,
} from '../../src/session/storage.ts';
import {
  generateSessionTitle,
  shouldAutoTitleSession,
} from '../../src/session/autoTitle.ts';
import {
  parseMcpToolName,
  toolRowLabel,
  toolRowTarget,
  toolRowTitle,
} from '../../src/ui/toolLabels.ts';
import { errorMessage } from '../../src/utils/errors.ts';
import type { PermissionMode } from '../../src/agent/permissions.ts';
import type { ToolRequest } from '../../src/agent/loop.ts';
import type { StreamUsage } from '../../src/providers/streams.ts';
import type { SessionCompactRow, SessionModelMessage, SessionRow } from '../../src/session/storage.ts';
import type { Session, SessionMode, TabMode } from '../../src/session/types.ts';

/** 스트리밍 화면 갱신 주기. 청크마다 갱신하면 렌더러가 포화돼 스크롤이 안 된다 */
const LIVE_FLUSH_MS = 80;

// React 상태 대신 emit으로 렌더러에 이벤트를 보내고, 입력 처리·스크롤·클립보드 등 화면 전용 로직은 렌더러가 맡음.
export function createController({
  session: initialSession,
  emit,
  notify,
  quit,
  startupNotice,
}: {
  session: Session;
  emit: (event: unknown) => void;
  /**
   * 턴이 끝나 사용자를 기다릴 때의 OS 알림. 창 포커스 판단과 실제 표시는
   * index(창 주인)가 맡는다 — viewing만 여기서 알려 준다
   */
  notify?: (info: { body: string; sessionId: string; title: string; viewing: boolean }) => void;
  quit: () => void;
  /**
   * 앱은 떴지만 대화는 못 하는 상태(예: API 키 없음)일 때의 사유. 있으면 시작 시
   * 기억 정리를 건너뛴다. 사용자 안내는 홈 화면이 isProviderReady로 따로 띄운다
   */
  startupNotice?: string;
}) {
  /**
   * 지금 화면이 보고 있는 세션. 세션을 옮길 때는 이 변수만 새 객체로 갈아끼운다 —
   * 객체를 제자리에서 바꾸면, 그 객체를 쥐고 돌던 백그라운드 턴이 남의 대화에
   * 기록한다. 턴은 시작할 때의 객체(Turn.session)를 끝까지 쓴다
   */
  let session: Session = initialSession;
  let mode = session.mode;
  /** 지금 열려 있는 탭 */
  let tabMode: TabMode = session.mode === 'chat' ? 'chat' : 'agent';
  /** mode 엔트리를 이미 파일에 남긴 세션들 (첫 메시지 때 한 번만 적는다). 화면
   * 분할로 포커스가 칸 사이를 오갈 때 각 세션의 기록 여부를 따로 기억해야 한다 */
  const recordedSessions = new Set<string>();
  /**
   * 세션별 마지막으로 파일에 남긴 설정(JSON) 스냅샷. 설정은 모델 칩·슬래시 명령·
   * 권한 칩 등 여러 경로로 바뀌므로 바뀐 곳마다 적는 대신, 바뀔 만한 시점에
   * persistConfig를 불러 이전 기록과 다를 때만 엔트리를 남긴다
   */
  const persistedConfigs = new Map<string, string>();
  /** UI에서 직접 띄운 승인(워크트리 제거 등)의 대기 슬롯. 턴의 승인은 Turn.approval에 */
  let pendingApprovalResolve: ((approved: boolean) => void) | null = null;

  /**
   * 진행 중인 턴. 세션마다 최대 하나.
   *
   * 세션을 옮겨도 턴을 끊지 않는다 — 자기 세션 객체를 쥐고 백그라운드에서 끝까지
   * 돌아 그 세션 파일에 기록한다. 화면 이벤트는 그
   * 세션을 보고 있을 때만 내보내고, 돌아오면 거울(unsavedRows)로 화면을 되살린다.
   */
  type Turn = {
    abort: AbortController;
    /** 승인 대기. 다른 세션을 보는 동안 걸리면 돌아왔을 때 다시 띄운다 */
    approval: { request: unknown; resolve: (approved: boolean) => void } | null;
    /** 세션이 삭제돼 결과를 어디에도 남기면 안 되는 턴 */
    deleted: boolean;
    /**
     * 지금 라운드의 생성이나 도구 실행만 끊는다 (턴은 이어진다). "지금 보내기"가
     * 불러, 끼어든 메시지를 라운드가 끝나기를 기다리지 않고 다음 라운드에서 읽게 한다
     */
    interruptRound: (() => void) | null;
    /** 턴이 도는 동안 사용자가 보낸 메시지. 루프가 라운드 사이에 꺼내 간다 */
    pendingInterjections: Interjection[];
    session: Session;
    status: { label: string; startedAt: number } | null;
    /** 이 턴의 마지막 실측 usage (다른 세션을 보는 동안에도 모아 두었다가 파일에 남긴다) */
    usage: StreamUsage | null;
    /** 이 턴에서 지금까지 생성한 출력 토큰 누계 (상태 줄 표시용) */
    spentOutput: number;
  };
  const turns = new Map<string, Turn>();
  /**
   * 아직 파일에 없는 행(persist: false로 붙인 것)의 세션별 거울 — 진행 중인 턴의
   * 행과 아직 안 읽은 끼어든 메시지. 턴이 끝나 파일에 적히면 지운다. 세션을
   * 옮겼다 돌아왔을 때 파일 내용 뒤에 이어 붙여 화면을 되살린다
   */
  const unsavedRows = new Map<string, SessionRow[]>();
  /**
   * 돌고 있는 백그라운드 보조 에이전트 (세션 id → spawn_agent 호출 id → 중단기).
   * 부모 턴이 끝나도 계속 돌므로 턴이 아니라 세션에 매단다 — Esc와 세션 삭제가
   * 여기를 보고 끊는다
   */
  const backgroundAgents = new Map<string, Map<string, AbortController>>();
  /**
   * 도착했지만 아직 모델에게 넘기지 못한 보조 에이전트 보고 (세션 id별). 턴이
   * 돌고 있으면 다음 라운드가 끼어든 메시지와 함께 꺼내 가고, 턴이 없으면
   * 자동 턴을 열어 넘긴다
   */
  const pendingReports = new Map<string, Interjection[]>();
  /**
   * 승인 창은 턴마다 한 슬롯뿐이다. 부모와 백그라운드 자식이 동시에 물으면 뒤의
   * 것이 앞의 것을 덮어 앞의 도구가 영영 기다리므로, 승인 요청을 한 줄로 세운다
   */
  let approvalChain: Promise<unknown> = Promise.resolve();
  // 마지막 프로바이더 호출의 실측 usage (보고 있는 세션 기준). 프롬프트에 전체
  // 이력이 들어가므로 입력+출력 토큰이 곧 현재 컨텍스트 점유량임
  let lastUsage: StreamUsage | null = null;
  let distillInFlight = false;
  /**
   * 세션별 마지막 실패 턴의 입력. 각 칸의 "다시 시도"가 자기 세션 것을 쓴다.
   * continuation이면 끝낸 라운드가 이력에 남아 있어, 같은 요청 대신 이어서 하라는
   * 새 메시지를 보낸다
   */
  const lastFailedTurns = new Map<
    string,
    { continuation?: boolean; images: string[]; text: string }
  >();
  /** 세션별로 마지막에 차단이 쌓여 멈춘 턴의 막힌 호출. "허용하고 이어서"가 이것만 허용한다 */
  const lastBlockedCalls = new Map<string, BlockedCall[]>();
  /**
   * 막힌 도구 행의 "이 명령 허용"이 허용할 수 있는 호출 (행 id → 세션과 명령).
   *
   * 화면은 행 id만 보낸다. 허용할 명령은 여기 기록해 둔 것을 쓴다 — 화면이 보낸
   * 문자열을 허용 목록에 넣으면, 렌더러가 무엇을 보내든 그 명령이 판정 없이 실행된다.
   * 행 id로 세션까지 찾으므로 화면을 나눠 다른 대화가 앞에 있어도 그 행의 세션에 적용된다
   */
  const allowableBlocks = new Map<string, { command: string; sessionId: string }>();
  /**
   * /compact가 이력을 접고 있는 세션. 그동안 온 메시지는 받지 않는다 — 턴이 없어
   * 끼어든 메시지로 줄 세울 수도 없고, 새 턴을 열면 접는 중인 이력과 엇갈린다
   */
  const compactingSessions = new Set<string>();
  /** 마지막 라운드가 실제로 보낸 입력. 컨텍스트 구성별 측정의 재료 */
  let lastTurnInputs: TurnInputs | null = null;

  /**
   * 지금 화면의 칸(pane)들이 보고 있는 세션들. 포커스 세션(session)은 항상 이 안에
   * 있다. per-session 이벤트는 이 집합에 든 세션에 대해서만, sessionId를 붙여
   * 내보낸다 — 렌더러가 어느 칸의 이벤트인지 구분해 라우팅한다. 화면 분할이 없을
   * 때는 포커스 세션 하나만 들어 있어 예전과 동작이 같다
   */
  const viewed = new Map<string, Session>();
  viewed.set(session.sessionId, session);

  /** 이 세션을 지금 화면의 어떤 칸이라도 보고 있는가 — 화면 이벤트를 내보낼지의 기준 */
  const viewing = (target: Session) => viewed.has(target.sessionId);
  /** 포커스된 세션의 진행 중인 턴 */
  const currentTurn = () => turns.get(session.sessionId) ?? null;

  /**
   * target 세션의 이벤트를 그 세션을 보는 칸으로 내보낸다. 보고 있지 않으면 버린다.
   * 모든 per-session 이벤트에 sessionId를 실어 렌더러가 칸별로 라우팅하게 한다
   */
  function emitTo(target: Session, event: Record<string, unknown>) {
    if (viewed.has(target.sessionId)) emit({ ...event, sessionId: target.sessionId });
  }

  /**
   * 포커스 세션을 next로 교체한다. 이전 포커스 세션이 (분할된) 다른 칸에서도
   * 보고 있지 않으면 viewed에서 뺀다 — 같은 세션이 두 칸에 동시에 뜨는 일은 없다는
   * 전제. 칸을 추가/제거하는 경로(openViewedSession·closeViewedSession)는 별도.
   */
  function setFocusedSession(next: Session, keepPrevViewed = false) {
    if (session.sessionId !== next.sessionId && !keepPrevViewed) {
      viewed.delete(session.sessionId);
    }
    session = next;
    viewed.set(next.sessionId, next);
  }

  /**
   * IPC가 준 sessionId로 대상 세션 객체를 찾는다 — 보이는 칸이나 돌고 있는 턴에서.
   * 못 찾거나 인자가 없으면 포커스 세션. 각 칸의 중단·승인·다시시도가 자기 세션의
   * 턴을 정확히 겨냥하게 한다
   */
  function resolveTarget(sessionId?: string | null): Session {
    if (sessionId) {
      const found = viewed.get(sessionId) ?? turns.get(sessionId)?.session;
      if (found) return found;
    }
    return session;
  }

  // 사용자가 방금 스스로 정정한 경우, 다음 앱 시작(startup)의 자동 기억 정리를 기다리지 않고
  // 같은 세션 안에서 바로 다시 정리해 잘못된 내용이 메모리에 반영되는 걸 막는다
  async function distillCorrectionNow(target: Session) {
    if (target.mock || distillInFlight) return;
    distillInFlight = true;
    try {
      await distillUnprocessedLogs(target);
    } catch {
      // 정정 즉시 다시 정리하다 실패하면 조용히 무시 — 다음 앱 시작 시 자동 기억 정리가 재시도함
    } finally {
      distillInFlight = false;
    }
  }

  function mirrorOf(target: Session): SessionRow[] {
    let rows = unsavedRows.get(target.sessionId);
    if (!rows) {
      rows = [];
      unsavedRows.set(target.sessionId, rows);
    }
    return rows;
  }

  /**
   * 파일에 적힌 행을 거울에서 뺀다. keep에 든 id(아직 안 읽은 끼어든 메시지)와,
   * 아직 돌고 있는 백그라운드 보조 에이전트의 자식 행은 남긴다 — 그 보고는 아직
   * 파일에 없어 되살릴 길이 없다
   */
  function markRowsSaved(target: Session, keep: Set<string> = new Set()) {
    const agents = backgroundAgents.get(target.sessionId);
    unsavedRows.set(
      target.sessionId,
      mirrorOf(target).filter(
        row =>
          (row.id !== undefined && keep.has(row.id)) ||
          (row.parentId !== undefined && agents?.has(row.parentId.replace(/^tool-/, '')) === true),
      ),
    );
  }

  /** 세션의 백그라운드 보조 에이전트를 전부 끊는다. 끊은 수를 돌려준다 */
  function abortBackgroundAgents(sessionId: string): number {
    const agents = backgroundAgents.get(sessionId);
    if (!agents?.size) return 0;
    for (const abort of agents.values()) abort.abort();
    return agents.size;
  }

  // 행 갱신은 항상 "어느 세션의 행인지"를 받는다. 화면에는 그 세션을 보고 있을
  // 때만 내보내고, 파일에 없는 행은 거울에도 반영해 돌아왔을 때 되살린다
  function appendRowTo(
    target: Session,
    row: SessionRow & { persist?: boolean; homeOnly?: boolean },
  ) {
    const nextRow = { id: row.id ?? randomUUID(), ...row };
    const { persist, ...storedRow } = nextRow;
    if (persist !== false) recordSessionRow(target, storedRow);
    // homeOnly(시작 알림)는 화면에서 걸러지는 것이라 되살릴 필요가 없다
    else if (!row.homeOnly) mirrorOf(target).push({ ...storedRow });
    emitTo(target, { type: 'row:append', row: storedRow });
    return storedRow.id;
  }

  function updateRowIn(target: Session, id: string, content: string, role?: string) {
    const mirrored = mirrorOf(target).find(row => row.id === id);
    if (mirrored) {
      mirrored.content = content;
      if (role) mirrored.role = role as SessionRow['role'];
    }
    emitTo(target, { type: 'row:update', id, content, role });
  }

  function patchRowIn(target: Session, id: string, patch: Partial<SessionRow>) {
    const mirrored = mirrorOf(target).find(row => row.id === id);
    if (mirrored) Object.assign(mirrored, patch);
    emitTo(target, { type: 'row:patch', id, patch });
  }

  // 보고 있는 세션용 단축형 (슬래시 명령·오류 안내 등 화면에서 비롯된 행)
  function appendRow(row: SessionRow & { persist?: boolean; homeOnly?: boolean }) {
    return appendRowTo(session, row);
  }

  function updateRow(id: string, content: string, role?: string) {
    updateRowIn(session, id, content, role);
  }

  function patchRow(id: string, patch: Partial<SessionRow>) {
    patchRowIn(session, id, patch);
  }

  /** 보고 있는 세션의 진행 상태(작업 중·상태 줄·승인 대기)를 화면에 맞춘다 */
  function emitViewState(target: Session = session) {
    const turn = turns.get(target.sessionId) ?? null;
    emitTo(target, { type: 'busy', value: turn !== null });
    emitTo(target, { type: 'status', status: turn?.status ?? null });
    emitTo(target, { type: 'turn-tokens', used: turn ? turn.spentOutput : null });
    emitTo(target, { type: 'approval', request: turn?.approval?.request ?? null });
  }

  function setNotice(text: string | undefined) {
    emit({ type: 'notice', text: text ?? '' });
  }

  /*
   * 대화와 무관한 오류(시작 실패, 기억 정리, 세션 파일 조작)를 알린다.
   *
   * 예전에는 이것들도 transcript에 error 행으로 넣었는데, 앱을 켜자마자 나는
   * 오류는 텅 빈 대화창에 빨간 줄 하나만 남아 보기 흉했고, 대화 기록도 아닌
   * 내용이 대화에 섞였다. 지금은 팝업으로 띄우고 대화는 건드리지 않는다.
   * 턴 안에서 난 오류와 슬래시 명령의 실패는 대화의 일부이므로 그대로 둔다.
   */
  function setAlert(text: string) {
    emit({ type: 'alert', text });
  }

  function setMode(value: SessionMode) {
    mode = value;
    session.mode = value;
    applyToolMode(value);
    emitTo(session, { type: 'mode', value });
  }

  /*
   * 레지스트리에 지금 모드를 알린다. 이게 없으면 채팅 탭에서도 파일·셸 도구
   * 정의가 그대로 실려 나간다.
   *
   * 불러온 지연 도구도 함께 비운다. 코딩에서 불러둔 것이 채팅으로 따라오면
   * 목록에 안 보이는 도구가 갑자기 붙어 있는 셈이 된다.
   */
  function applyToolMode(value: SessionMode) {
    clearLoadedTools();
    setToolMode(value === 'chat' ? 'chat' : 'coding');
  }

  function changePermissionMode(nextMode: PermissionMode) {
    // IPC로 들어온 값은 타입이 보장되지 않는다. 목록 밖 값이 세션 파일에 남지 않게 거른다
    if (!PERMISSION_MODES.includes(nextMode)) return;
    session.permissionMode = nextMode;
    emitTo(session, { type: 'permission-mode', value: nextMode });
    setNotice(`권한 모드: ${PERMISSION_MODE_LABELS[nextMode]}`);
    persistConfig();
  }

  /**
   * 제공자·모델·추론 강도·권한 모드가 바뀌었으면 세션 파일에 남긴다.
   * 파일이 아직 없는 대화(첫 메시지 전)는 건너뛴다 — 그 값은 첫 메시지 때
   * 한꺼번에 적힌다. 빈 대화가 파일로 남지 않게 하려는 mode 엔트리와 같은 규칙
   */
  function persistConfig(target: Session = session) {
    if (!recordedSessions.has(target.sessionId)) return;
    const snapshot = JSON.stringify(sessionConfigOf(target));
    if (snapshot === persistedConfigs.get(target.sessionId)) return;
    persistedConfigs.set(target.sessionId, snapshot);
    recordSessionConfig(target);
  }

  /*
   * 지금 제공자로 대화할 수 있는가(키·주소가 있는가). 처음 설치한 사람에게 시작하자마자
   * 오류 팝업을 띄우는 대신, 홈 화면이 이 값으로 연결 안내를 보여 준다.
   * 설정창에서 키를 넣으면 바로 환경에 반영되므로 렌더러가 설정창을 닫을 때 다시 묻는다
   */
  function isProviderReady() {
    try {
      assertProviderReady(session);
      return true;
    } catch {
      return false;
    }
  }

  async function getInitialState() {
    // 모드 선택 메뉴에 보여줄 목록
    const permissionModes = PERMISSION_MODES.map(value => ({
      value,
      label: PERMISSION_MODE_LABELS[value],
    }));

    return {
      commands: SLASH_COMMANDS,
      mode,
      model: session.model,
      permissionMode: session.permissionMode ?? DEFAULT_PERMISSION_MODE,
      permissionModes,
      provider: session.provider,
      providerReady: isProviderReady(),
      providers: PROVIDERS,
      reasoningEffort: getReasoningEffort(),
      reasoningEfforts: REASONING_EFFORT_OPTIONS,
      rows: session.initialRows ?? [],
      sessionId: session.sessionId,
      tabMode,
      tokens: getContextUsage(),
      version: APP_VERSION,
      workspace: await getWorkspace(),
    };
  }

  /*
   * 설정창 값 읽기·쓰기.
   *
   * 저장해도 지금 진행 중인 턴에는 반영되지 않는다. 시스템 프롬프트는 턴이
   * 시작될 때 조립되기 때문이다. 다음 턴부터 적용된다.
   */
  function getPreferences(): Preferences {
    return readPreferences();
  }

  function savePreferences(patch: unknown): Preferences {
    // 렌더러에서 온 값이므로 저장 전에 모양을 맞춘다
    return writePreferences(sanitizePreferences(patch));
  }

  async function getWorkspace() {
    const cwd = process.cwd();
    return {
      branch: await getCurrentGitBranch(),
      folder: basename(cwd),
      // 칩에는 폴더 이름만 들어가는데, 같은 이름의 폴더가 여럿이면 어느 것인지
      // 알 수 없다. 전체 경로는 툴팁으로 넘긴다
      path: cwd,
    };
  }

  function emitWorkspace() {
    void getWorkspace().then(workspace => emit({ type: 'workspace', workspace }));
  }

  // 소스 컨트롤 패널용: main(merge-base) 대비 변경 통계와 파일별 diff.
  // git 저장소가 아니거나 실패하면 null (렌더러가 칩·패널을 숨김)
  function getGitDiffSummary() {
    return fetchGitDiffSummary();
  }

  function getGitDiffFiles() {
    return fetchGitFileDiffs();
  }

  // 브랜치 칩 메뉴용 로컬 브랜치 목록
  async function listBranches() {
    const branches = await listGitBranches();
    if (branches === null) {
      return { branches: [], current: null, error: 'git 저장소가 아닙니다' };
    }
    return { branches, current: await getCurrentGitBranch() };
  }

  // 브랜치 칩에서 선택: 전환 실패(충돌 등)는 notice로 알림
  function checkoutBranch(name: string) {
    try {
      checkoutGitBranch(String(name));
      setNotice(`브랜치를 ${name}(으)로 전환했습니다.`);
    } catch (error) {
      setAlert(`브랜치 전환 실패: ${errorMessage(error)}`);
    }
    emitWorkspace();
  }

  // 워크트리 칩 목록용: 실패(git 저장소 아님 등)는 error 필드로 알림
  async function listWorktreeEntries() {
    try {
      return { worktrees: await getWorktrees() };
    } catch (error) {
      return { worktrees: [], error: errorMessage(error) };
    }
  }

  // 워크트리 칩에서 생성: LLM 도구 addWorktree와 같은 핵심 로직을 UI에서 직접 호출.
  // base를 주면 그 브랜치/커밋에서 새 브랜치를 출발시키고, 생략하면 현재 HEAD.
  async function createWorktree(name: string, base?: string) {
    try {
      const message = await addWorktree(String(name), undefined, base ? String(base) : undefined);
      setNotice(message.split('\n')[0]);
      return { ok: true, message };
    } catch (error) {
      const message = errorMessage(error);
      setAlert(`워크트리 생성 실패: ${message}`);
      return { ok: false, message };
    }
  }

  // UI에서 직접 실행하는 위험 동작의 승인 요청. 턴의 승인(Turn.approval)과는
  // 따로 pendingApprovalResolve 슬롯 하나를 쓰므로, 이미 다른 UI 승인이 대기 중이면
  // 새 요청을 거부로 흘려 슬롯 충돌을 막는다.
  function requestApproval(label: string, detail: string): Promise<boolean> {
    if (pendingApprovalResolve) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      pendingApprovalResolve = resolve;
      emit({ type: 'approval', request: { label, detail, reason: null } });
    });
  }

  // 워크트리 칩에서 제거(연결된 브랜치 정리 포함). 워크트리와 거기 딸린 브랜치가
  // 함께 사라져 되돌리기 어려우므로, 도구 게이트의 confirm 등급과 같은 기준으로
  // 자동 모드에서도 승인을 받는다. force면 커밋되지 않은 변경이 있어도 강제 제거.
  async function removeWorktreeEntry(name: string, force: boolean) {
    const mode = session.permissionMode ?? DEFAULT_PERMISSION_MODE;
    const gate = approvalConfirm(`워크트리 '${name}'를 제거합니다 (되돌리기 어려움).`);
    // 'deny'도 확인 대상으로 본다. 자동 모드의 차단은 모델이 스스로 부른 도구를
    // 막는 장치인데, 여기는 사용자가 방금 버튼을 누른 자리다. 눌렀는데 아무 일도
    // 안 일어나면 고장으로 보이고, 그렇다고 그냥 실행하면 확인 없이 지워진다
    if (decideToolPermission(mode, 'execute', gate) !== 'allow') {
      // 제거 대상 워크트리의 브랜치 이름을 미리 찾아 승인 문구에 명시한다.
      // 이 브랜치는 출발 브랜치가 아니라 거기서 복사돼 만들어진 새 브랜치이므로,
      // 이름과 "출발 브랜치는 유지"를 함께 보여줘 사용자 착각을 막는다.
      let branch: string | null = null;
      try {
        const entries = await getWorktrees();
        branch = entries.find(entry => entry.managedName === name)?.branch ?? null;
      } catch {
        // 조회 실패 시 브랜치 없이 안내
      }
      const label = branch
        ? `워크트리 '${name}' 제거 — 이 워크트리의 브랜치 '${branch}'도 삭제 (출발 브랜치는 유지)`
        : `워크트리 '${name}' 제거`;
      const approved = await requestApproval(
        label,
        `.newbie/worktrees/${name} 워크트리를 제거합니다 (되돌리기 어려움).`,
      );
      if (!approved) {
        setNotice('워크트리 제거를 취소했습니다.');
        return { ok: false, message: '취소됨' };
      }
    }
    try {
      const message = await removeWorktree(String(name), Boolean(force));
      // 제거 메시지는 여러 줄(폴더 + 브랜치 처리)이라 토스트에선 한 줄로 이어붙임
      setNotice(message.split('\n').join(' · '));
      return { ok: true, message };
    } catch (error) {
      const message = errorMessage(error);
      setAlert(`워크트리 제거 실패: ${message}`);
      return { ok: false, message };
    }
  }

  // 폴더 칩에서 선택한 디렉터리로 작업 디렉터리 변경.
  // 시스템 프롬프트의 환경 정보·도구의 상대 경로 기준이 즉시 새 폴더를 따라감.
  // 세션의 projectPath도 함께 옮겨 이후 기록·재개가 새 폴더를 따르게 함.
  function changeWorkingDirectory(path: string) {
    // 돌고 있는 턴은 시작할 때의 폴더를 끝까지 쓴다. 지금 바꾸면 세션의 projectPath와
    // 턴이 실제로 일하는 폴더가 갈라져 기록이 엉뚱한 곳에 남는다
    if (isTurnInFlight()) {
      setNotice('답변이 끝난 뒤에 작업 폴더를 바꿀 수 있습니다.');
      return;
    }
    // 대화가 시작된 세션은 폴더를 바꾸면 이력이 두 프로젝트로 쪼개지므로 막는다.
    // (새 대화에서 폴더를 먼저 고르는 흐름만 지원)
    if (session.lastTranscriptUuid) {
      setNotice('대화가 시작된 세션은 폴더를 바꿀 수 없습니다. 새 대화에서 폴더를 선택하세요.');
      return;
    }
    try {
      process.chdir(String(path));
      repointSessionProject(session, process.cwd());
      setNotice(`작업 폴더: ${process.cwd()}`);
    } catch (error) {
      setAlert(`폴더 변경 실패: ${errorMessage(error)}`);
    }
    emitWorkspace();
  }

  // 모델 칩 UI에서 제공자 변경: /provider 빌트인과 같은 검증·롤백
  function setProvider(name: string) {
    const previousProvider = session.provider;
    const previousModel = session.model;
    try {
      session.provider = normalizeProvider(String(name));
      session.model = getDefaultModel(session.provider);
      assertProviderReady(session);
      setNotice(`제공자: ${session.provider} · 모델: ${session.model}`);
      // 모델이 바뀌면 이전 실측 usage는 더 이상 유효하지 않음 (토크나이저가 다름)
      lastUsage = null;
      persistConfig();
    } catch (error) {
      session.provider = previousProvider;
      session.model = previousModel;
      // 제공자가 조용히 원래대로 돌아간다. 5초 뒤 사라지는 알림에 두면
      // 왜 안 바뀌었는지 모른 채 넘어간다
      setAlert(`제공자를 바꾸지 못했습니다: ${errorMessage(error)}`);
    }
    emitSessionMeta();
    refreshContextWindow();
  }

  // 모델 칩 메뉴용: 현재 제공자의 사용 가능한 모델 목록
  async function listModels() {
    try {
      return { models: await listProviderModels(session.provider) };
    } catch (error) {
      const reason = errorMessage(error);
      return {
        models: [],
        error:
          reason === 'fetch failed'
            ? `${session.provider} 서버에 연결할 수 없습니다`
            : `모델 목록을 불러오지 못했습니다: ${reason}`,
      };
    }
  }

  function setModel(name: string) {
    const trimmed = String(name ?? '').trim();
    if (trimmed) {
      session.model = trimmed;
      setNotice(`모델을 ${trimmed}(으)로 변경했습니다.`);
      lastUsage = null;
      persistConfig();
    }
    emitSessionMeta();
    refreshContextWindow();
  }

  // 노력 칩에 보여줄 값. 추론 강도가 의미 없는 조합(다른 제공자, gpt-4o 등)에는
  // null을 보내 칩 자체를 숨긴다 — 효과 없는 설정을 고르게 두지 않는다.
  // vLLM은 Qwen3.8의 reasoning_effort로 이어진다 (vllm.ts의 vllmReasoning)
  function reasoningEffortOf(target: Session): string | null {
    const applies =
      target.provider === 'vllm' ||
      (target.provider === 'openai' && isReasoningModel(target.model));
    if (!applies) return null;
    return target.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  }

  function getReasoningEffort(): string | null {
    return reasoningEffortOf(session);
  }

  function setReasoningEffort(value: unknown) {
    if (!isReasoningEffort(value)) return;
    session.reasoningEffort = value;
    const label = REASONING_EFFORT_OPTIONS.find(entry => entry.value === value)?.label ?? value;
    setNotice(`추론 노력: ${label}`);
    persistConfig();
    emitSessionMeta();
  }

  // 사이드바 세션 목록용 요약 — 모든 프로젝트의 세션을 포함함
  // (Date는 IPC 직렬화를 위해 ISO 문자열로)
  function getSessionList() {
    return listSessionsRemembering().map(summary => ({
      created: summary.created.toISOString(),
      firstPrompt: summary.firstPrompt,
      mode: summary.mode,
      modified: summary.modified.toISOString(),
      name: summary.name,
      projectName: basename(summary.projectPath),
      projectPath: summary.projectPath,
      sessionId: summary.sessionId,
    }));
  }

  /**
   * 세션 id → 프로젝트 경로. listAllSessions는 모든 프로젝트 폴더를 동기로 훑으므로
   * 포커스 이동처럼 잦은 경로에서 매번 부르면 화면이 멈칫한다. 세션의 프로젝트는
   * 바뀌지 않으니 한 번 본 값은 그대로 쓴다
   */
  const sessionProjectPaths = new Map<string, string>();

  function listSessionsRemembering() {
    const summaries = listAllSessions();
    for (const summary of summaries) {
      sessionProjectPaths.set(summary.sessionId, summary.projectPath);
    }
    return summaries;
  }

  // 세션이 속한 프로젝트 경로 (다른 프로젝트 세션의 resume·삭제·이름변경용).
  // 못 찾은 경우는 기억하지 않는다. 아직 파일이 없는 새 대화는 나중에 생기기 때문이다
  function findSessionProjectPath(sessionId: string) {
    const cached = sessionProjectPaths.get(sessionId);
    if (cached !== undefined) return cached;
    return (
      listSessionsRemembering().find(summary => summary.sessionId === sessionId)?.projectPath ??
      process.cwd()
    );
  }

  // 세션 컨텍스트 메뉴의 이름 변경
  function renameSession(sessionId: string, name: string) {
    try {
      renameSessionFile(String(sessionId), String(name ?? ''), findSessionProjectPath(String(sessionId)));
    } catch (error) {
      setAlert(`오류: ${errorMessage(error)}`);
    }
    return getSessionList();
  }

  // 컨텍스트 사용량: 마지막 프로바이더 호출의 실측값만 표시함.
  // 실측값은 API 응답에만 있으므로 첫 응답 전에는 null을 보내 게이지를 숨김
  function getContextUsage() {
    if (!lastUsage) return null;
    return {
      // 입력 중 캐시에서 읽은 몫. 0에 가까우면 캐시가 안 걸리고 있다는 뜻이라,
      // 도구 정의 같은 고정 구간을 매번 정가로 결제하고 있는 것이다
      cached: lastUsage.cachedInputTokens ?? 0,
      input: lastUsage.inputTokens,
      used: lastUsage.inputTokens + lastUsage.outputTokens,
      window: resolveContextWindow(session.provider, session.model),
    };
  }

  /**
   * 지금 메시지를 보낸다면 무엇이 실릴지 조립한다.
   *
   * 턴이 실제로 보낸 것과 완전히 같지는 않다 — 시스템 프롬프트에 들어가는 git
   * 스냅샷 같은 환경 정보는 지금 값으로 다시 만들어지고, 도구 필터(도구 검색
   * 등)도 반영되지 않는다. 다만 "무엇이 컨텍스트를 차지하는가"라는 질문에는
   * 오히려 지금 기준이 답이 된다.
   *
   * 대화는 담지 않는다 — 측정이 고정 구성만 보기 때문이다.
   */
  async function buildCurrentInputs(target: Session = session): Promise<TurnInputs> {
    // 도구 형식은 루프가 실제로 보내는 것과 같아야 한다 (loop.ts와 같은 분기).
    // Anthropic 형식을 vLLM·llama.cpp에 보내면 서버가 400을 내거나 다르게 센다
    const toolMode = target.mode === 'chat' ? 'chat' : 'coding';
    return {
      model: target.model,
      provider: target.provider,
      systemPrompt: await buildSystemPrompt(target),
      tools:
        target.provider === 'anthropic'
          ? getAnthropicTools(toolMode)
          : getOpenAITools(toolMode),
    };
  }

  /**
   * 실패한 턴을 같은 입력으로 다시 보낸다.
   *
   * submit을 다시 부르지 않는 이유: 그러면 사용자 메시지 행이 하나 더 생긴다.
   * 실패한 오류 행은 지우지 않고 그대로 둔다 — 무슨 일이 있었는지가 기록이고,
   * 화면은 마지막 행이 아닌 오류의 버튼을 숨기므로 두 번 눌릴 일도 없다.
   */
  async function retryLastTurn(sessionId?: string) {
    const target = resolveTarget(sessionId);
    const failed = lastFailedTurns.get(target.sessionId);
    if (!failed || turns.get(target.sessionId)) return;
    lastFailedTurns.delete(target.sessionId);

    // 끝낸 라운드가 이력에 남아 있는 실패는 같은 요청을 처음부터 다시 보내지 않는다
    if (failed.continuation) {
      await sendFollowUp(target, failed.text);
      return;
    }

    emitTo(target, { type: 'busy', value: true });
    try {
      await runTurnChain(target, failed.text, failed.images, { retry: true });
    } finally {
      emitTo(target, { type: 'busy', value: false });
      if (target.sessionId === session.sessionId) {
        persistConfig();
        emitSessionMeta();
      }
    }
  }

  /**
   * 사용자 대신 앱이 보내는 후속 메시지 (멈춤 안내의 버튼, 오류 뒤 이어서 하기).
   * 말풍선을 남겨, 모델이 왜 다시 움직이는지 사용자도 대화에서 볼 수 있게 한다
   */
  async function sendFollowUp(target: Session, text: string) {
    if (turns.get(target.sessionId)) return;
    const at = new Date().toISOString();
    appendRowTo(target, { at, readAt: at, role: 'user', content: text, persist: false });
    emitTo(target, { type: 'busy', value: true });
    try {
      await runTurnChain(target, text, [], { at });
    } finally {
      emitTo(target, { type: 'busy', value: false });
      if (target.sessionId === session.sessionId) {
        persistConfig();
        emitSessionMeta();
      }
    }
  }

  /**
   * 멈춤 안내의 "이어서 하기"와 "허용하고 이어서".
   *
   * 허용은 그 턴에서 실제로 막혀 안내에 보였던 명령만 한다. 화면이 보낸 목록을 믿지
   * 않고 컨트롤러가 붙잡아 둔 목록을 쓴다. 허용은 정확히 같은 문자열에만 적용되고,
   * 앱을 다시 켜면 사라진다 (session.approvedCommands)
   */
  async function continueAfterStop(sessionId?: string, approveBlocked = false) {
    const target = resolveTarget(sessionId);
    if (turns.get(target.sessionId)) return;
    const blocked = approveBlocked ? (lastBlockedCalls.get(target.sessionId) ?? []) : [];
    if (blocked.length) {
      target.approvedCommands = [
        ...new Set([...(target.approvedCommands ?? []), ...blocked.map(call => call.command)]),
      ];
      lastBlockedCalls.delete(target.sessionId);
    }
    await sendFollowUp(
      target,
      blocked.length
        ? `막혔던 명령 ${blocked.length}개를 허용했습니다. 이어서 진행해 주세요.`
        : CONTINUE_PROMPT,
    );
  }

  /**
   * 막힌 도구 행의 "이 명령 허용".
   *
   * 그 행의 명령을 정확히 같은 문자열로만, 앱을 다시 켤 때까지 허용한다 (멈춤 안내의
   * "허용하고 이어서"와 같은 허용 목록). 그다음 모델에게 다시 실행하라고 알린다. 턴이
   * 돌고 있으면 끼어들어 다음 라운드에서 바로 읽게 하고, 끝났으면 새 턴으로 보낸다.
   * 자동 모드의 분류기는 사용자가 대화로 "해"라고 해도 차단 목록을 풀지 않으므로, 사용자가
   * 직접 고른 명령만 이 길로 푼다
   */
  async function allowBlockedCall(rowId: string) {
    const block = allowableBlocks.get(rowId);
    if (!block) return;
    const target = resolveTarget(block.sessionId);
    if (target.sessionId !== block.sessionId) return;
    allowableBlocks.delete(rowId);
    target.approvedCommands = [...new Set([...(target.approvedCommands ?? []), block.command])];
    patchRowIn(target, rowId, { allowed: true });

    const text = [
      '막혔던 아래 명령을 허용했습니다. 글자 하나 바꾸지 말고 그대로 다시 실행해 주세요.',
      '```',
      block.command,
      '```',
    ].join('\n');
    const running = turns.get(target.sessionId);
    if (!running) {
      await sendFollowUp(target, text);
      return;
    }
    const at = new Date().toISOString();
    const id = appendRowTo(target, { at, role: 'user', content: text, persist: false });
    running.pendingInterjections.push({ at, id, images: [], text });
    interjectNow(target.sessionId, id);
  }

  /**
   * 작업 중에 보낸 메시지를 지금 라운드가 끝나기를 기다리지 않고 모델에게 넘긴다.
   *
   * 진행 중인 생성이나 도구 실행을 끊으면 루프가 다음 라운드에서 그 메시지를 읽는다.
   * 승인 창이 떠 있으면 승인하지 않은 것으로 닫는다 — 루프가 그 답을 기다리는
   * 동안에는 라운드를 끊어도 넘어가지 않고, 사용자는 승인 대신 말을 건 것이다
   */
  function interjectNow(sessionId?: string, rowId?: string) {
    const target = resolveTarget(sessionId);
    const turn = turns.get(target.sessionId);
    if (!turn) return;
    if (rowId && !turn.pendingInterjections.some(item => item.id === rowId)) return;
    if (turn.approval) {
      const { resolve } = turn.approval;
      turn.approval = null;
      emitTo(target, { type: 'approval', request: null });
      resolve(false);
    }
    turn.interruptRound?.();
  }

  /**
   * /compact. 진행 중인 턴이 없을 때 이력을 지금 접는다.
   *
   * 접는 동안은 "압축 중..." 줄을 띄우고, 끝나면 같은 줄을 "압축 완료"와 비운
   * 토큰 수로 바꾼다. 지난 턴은 요약으로, 마지막 턴은 최근 도구 라운드만 원문으로
   * 남긴다 — 루프가 창이 찼을 때 접는 방식과 같다
   */
  async function compactSessionNow(target: Session) {
    if (compactingSessions.has(target.sessionId)) return;
    compactingSessions.add(target.sessionId);
    const rowId = randomUUID();
    const finish = (compact: SessionCompactRow) => {
      patchRowIn(target, rowId, { compact });
      // "압축 중..."은 거울에만 있던 행이다. 끝난 모양으로 파일에 남기고 거울에서 뺀다
      const mirror = mirrorOf(target);
      const index = mirror.findIndex(row => row.id === rowId);
      if (index !== -1) mirror.splice(index, 1);
      recordSessionRow(target, { compact, content: '', id: rowId, role: 'compact' });
    };
    appendRowTo(target, {
      compact: { state: 'running', trigger: 'manual' },
      content: '',
      id: rowId,
      persist: false,
      role: 'compact',
    });
    try {
      const usable =
        target.compaction && target.compaction.foldedCount <= target.messages.length
          ? target.compaction
          : undefined;
      const contextWindow = resolveContextWindow(target.provider, target.model);
      const history = usable
        ? applyCompactionCheckpoint(target.messages, usable, contextWindow)
        : [...target.messages];
      const before = await measureHistoryTokens(target, history);
      // 요약 요청을 턴의 요청과 같은 시스템 프롬프트와 도구로 보내, 제공자가 지난 턴에
      // 계산해 둔 앞부분을 다시 쓰게 한다
      const inputs = await buildCurrentInputs(target);
      const result = await compactMessages(target, history, {
        checkpoint: usable,
        contextWindow,
        keepToolRounds: KEEP_RECENT_TOOL_ROUNDS,
        systemPrompt: inputs.systemPrompt,
        tools: inputs.tools,
      });
      if (!result.compacted || !result.checkpoint) {
        finish({ state: 'skipped', trigger: 'manual' });
        return;
      }
      const folded = target.messages.indexOf(result.checkpoint.lastFolded);
      if (folded === -1) {
        finish({ error: '접은 자리를 대화에서 찾지 못했습니다.', state: 'failed', trigger: 'manual' });
        return;
      }
      target.compaction = {
        foldedCount: folded + 1,
        prompts: result.checkpoint.prompts,
        summary: result.checkpoint.summary,
      };
      recordSessionCompaction(target, target.compaction);
      // 접기 전 크기는 창까지만 센다 (루프의 자동 압축과 같은 기준)
      const freedTokens = Math.max(
        0,
        Math.min(before, contextWindow) - (await measureHistoryTokens(target, result.messages)),
      );
      finish({ brief: result.brief, freedTokens, state: 'done', trigger: 'manual' });
      // 게이지는 마지막 요청의 실측값이라 접기 전 크기에 머문다. 다음 요청이 실을
      // 크기로 맞춘다 — 접은 만큼 빼고, 지난 답(출력)은 이제 입력에 들어 있다
      if (target.sessionId === session.sessionId && lastUsage) {
        lastUsage = {
          ...lastUsage,
          inputTokens: Math.max(0, lastUsage.inputTokens + lastUsage.outputTokens - freedTokens),
          outputTokens: 0,
        };
        recordSessionUsage(target, {
          cached: lastUsage.cachedInputTokens,
          input: lastUsage.inputTokens,
          output: 0,
        });
        emit({ type: 'tokens', tokens: getContextUsage() });
      }
    } catch (error) {
      finish({ error: errorMessage(error), state: 'failed', trigger: 'manual' });
    } finally {
      compactingSessions.delete(target.sessionId);
    }
  }

  /**
   * 컨텍스트를 무엇이 차지하는지 구성별로 잰다. 화면이 팝업을 열 때만 부른다.
   *
   * 같은 입력이면 캐시를 돌려준다 — 측정 자체는 무료지만 왕복이 다섯 번이라
   * 팝업을 열 때마다 다시 재면 느리다. 새 라운드가 돌면 입력 객체가 새로
   * 만들어지므로 그때 자동으로 다시 잰다.
   */
  async function getContextBreakdown() {
    if (!supportsBreakdown(session.provider)) {
      return { provider: session.provider, reason: 'unsupported' as const, supported: false };
    }
    // try 안에서 조립까지 한다. 밖에 두면 시스템 프롬프트를 만들다 난 예외가
    // IPC를 통째로 거부시키고, 화면은 이유도 모른 채 "측정 중"에 머문다
    try {
      // 이번 실행에서 턴이 없었으면(앱을 새로 켰거나 예전 대화를 열었을 때) 지금
      // 보낸다면 무엇이 갈지를 다시 조립해서 잰다. 대화는 파일에서 복원돼 있고
      // 도구 목록·시스템 프롬프트는 언제든 다시 만들 수 있다
      // 같은 모델·프롬프트·도구 조합이면 measureBreakdown이 디스크 캐시로
      // 즉시 답한다. 앱을 껐다 켜도 유지된다
      const parts = await measureBreakdown(lastTurnInputs ?? (await buildCurrentInputs()));
      return { parts, supported: true };
    } catch (error) {
      return { error: errorMessage(error), reason: 'failed' as const, supported: false };
    }
  }

  // 로컬 프로바이더(ollama·lmstudio)의 실제 창 크기는 비동기 조회 후 게이지에 반영함
  function refreshContextWindow() {
    const provider = session.provider;
    const model = session.model;
    const fallback = resolveContextWindow(provider, model);
    void fetchContextWindow(provider, model).then(window => {
      // 조회 중 프로바이더·모델이 바뀌었으면 이 값은 버림
      if (!window || window === fallback) return;
      if (provider !== session.provider || model !== session.model) return;
      emitSessionMeta();
    });
  }

  function emitSessionMeta() {
    emitSessionMetaFor(session);
  }

  /**
   * 세션 메타(모델·제공자·추론강도)를 그 세션을 보는 칸으로 보낸다. 컨텍스트
   * 게이지(tokens)는 포커스된 세션만 실제 값을 싣는다 — 다른 칸의 값이 전역
   * 게이지를 덮으면 안 되므로, 포커스가 아니면 null을 보내 칸이 헤더 정보만 쓰게 한다
   */
  function emitSessionMetaFor(target: Session) {
    emitTo(target, {
      type: 'session-meta',
      model: target.model,
      provider: target.provider,
      reasoningEffort: reasoningEffortOf(target),
      sessionId: target.sessionId,
      tokens: target.sessionId === session.sessionId ? getContextUsage() : null,
    });
  }

  // 사이드바 "새 대화": 새 세션 객체로 갈아탄다. 진행 중인 턴은 끊지 않는다 —
  // 이전 객체를 쥔 채 백그라운드에서 끝까지 돌고, 화면 이벤트만 나가지 않는다
  function newSession(nextMode: TabMode = tabMode) {
    cancelPendingApproval();
    const created: Session = {
      ...session,
      initialRows: [],
      messages: [],
      // 권한 모드는 세션에 딸린 값이라 새 대화에서는 탭 기본값으로 되돌린다.
      // 이전 대화에서 낮춰 둔 모드가 조용히 따라오면, 칩에 보이는 값과 사용자가
      // 기대하는 값이 어긋난다.
      //
      // changePermissionMode를 쓰지 않는 이유는 그쪽이 알림을 띄우기 때문이다.
      // 사용자가 바꾼 것이 아니라 기본값으로 돌아온 것뿐이라, 새 대화를 열 때마다
      // "권한 모드: 자동" 배너가 뜨면 알림의 의미가 닳는다
      permissionMode: defaultPermissionMode(nextMode),
      ...createSessionPersistence(),
    };
    setFocusedSession(created);
    tabMode = nextMode;
    recordedSessions.delete(created.sessionId);
    persistedConfigs.delete(created.sessionId);
    emitTo(session, { type: 'permission-mode', value: session.permissionMode });
    setMode(nextMode);
    lastUsage = null;
    emitTo(session, { type: 'rows:set', rows: [] });
    emitViewState();
    emitSessionMeta();
    // 새 대화는 폴더 잠금이 풀려 칩 모양이 바뀐다. 이전 대화 동안 브랜치가
    // 바뀌었을 수도 있으니 여기서도 실제 상태를 다시 읽는다
    emitWorkspace();
    // 새 세션 id를 돌려준다 — 렌더러가 이 세션을 어느 칸에 물릴지 정한다
    return session.sessionId;
  }

  /**
   * 사이드바 프로젝트 그룹의 + 버튼: 그 폴더에서 코딩 대화를 새로 연다.
   *
   * 폴더 칩으로 고르는 것과 같은 경로를 탄다. 새 대화는 기록도 턴도 없으므로
   * changeWorkingDirectory의 막는 조건에 걸리지 않고, 다른 대화에서 돌고 있는
   * 턴은 자기 폴더에 고정돼 있어(runInWorkdir) 영향을 받지 않는다
   */
  function newSessionIn(path: string): string {
    newSession('agent');
    changeWorkingDirectory(path);
    return session.sessionId;
  }

  /**
   * 탭 전환. 같은 탭을 다시 누르면 아무것도 안 한다.
   *
   * 진행 중인 대화를 다른 모드로 옮기지 않고 새 대화를 연다. 코딩 대화 중간에
   * 파일 도구를 걷어내면 이미 오간 도구 호출 이력과 앞뒤가 안 맞는다.
   */
  // 탭 전환은 새 대화를 연다 (같은 탭이면 그대로). 새 세션 id를 돌려줘 렌더러가
  // 포커스된 칸을 그 세션으로 갈아끼우게 한다 — 안 그러면 칸이 옛 세션을 가리켜
  // 탭을 눌러도 화면이 안 바뀐다
  function setTabMode(next: unknown): string {
    const value: TabMode = next === 'chat' ? 'chat' : 'agent';
    if (value === tabMode) return session.sessionId;
    return newSession(value);
  }

  /**
   * 포커스된 세션의 설정(권한·모드·모델메타)을 그 세션을 보는 칸으로 다시 내보낸다.
   * 새 대화·탭 전환처럼 렌더러가 칸을 새 세션에 묶은 "뒤"에 불러, 칸이 묶이기 전에
   * 지나가 버린 상태 이벤트를 다시 받게 한다 (행은 새 세션이라 비어 있어 안 보낸다)
   */
  function resyncFocused() {
    emitTo(session, { type: 'permission-mode', value: session.permissionMode });
    emitTo(session, { type: 'mode', value: session.mode });
    emitViewState(session);
    emitSessionMetaFor(session);
  }

  // 세션 컨텍스트 메뉴의 삭제. 현재 세션을 지우면 새 세션으로 전환함.
  // 그 세션의 턴이 돌고 있으면 끊고, 결과도 남기지 않게 한다 (파일이 되살아나면 안 된다)
  function removeSession(sessionId: string) {
    const id = String(sessionId);
    const isCurrent = id === session.sessionId;
    const running = turns.get(id);
    if (running) {
      running.deleted = true;
      running.abort.abort();
    }
    abortBackgroundAgents(id);
    pendingReports.delete(id);
    unsavedRows.delete(id);
    // 분할된 다른 칸에서 보고 있었다면 그 칸도 이 세션을 더는 못 본다
    if (!isCurrent) viewed.delete(id);
    try {
      deleteSessionFile(id, findSessionProjectPath(id));
      sessionProjectPaths.delete(id);
      if (isCurrent) newSession();
    } catch (error) {
      setAlert(`오류: ${errorMessage(error)}`);
    }
    return getSessionList();
  }

  // 사이드바 세션 클릭: /resume 빌트인과 같은 동작 (사용자 행 없이).
  // 다른 프로젝트의 세션이면 작업 디렉터리도 그 프로젝트로 전환함.
  // 진행 중인 턴은 끊지 않는다 — 돌아오면 그 턴이 쥔 객체와 거울로 화면을 되살린다
  function resumeSession(sessionId: string, options: { keepPrevViewed?: boolean } = {}) {
    cancelPendingApproval();
    try {
      const id = String(sessionId);
      const projectPath = findSessionProjectPath(id);
      const loaded = loadSessionById(id, projectPath);
      // 전역 cwd는 화면이 보는 프로젝트를 따라간다 (git 칩·새 대화의 기준). 돌고 있는
      // 턴은 자기 projectPath를 컨텍스트로 쥐고 있어(runInWorkdir) 영향을 받지 않는다
      if (projectPath !== process.cwd()) {
        try {
          // 어느 폴더로 옮겼는지는 워크스페이스 칩이 이미 보여준다 — 알림까지
          // 띄우면 세션을 오갈 때마다 같은 말이 반복돼 소음이다
          process.chdir(projectPath);
        } catch {
          setAlert(`프로젝트 폴더를 열 수 없습니다: ${projectPath}`);
        }
        emitWorkspace();
      }
      const running = turns.get(id);
      if (running) {
        // 백그라운드에서 돌고 있는 대화로 돌아온 것 — 그 턴이 쥔 객체를 그대로 쓴다
        setFocusedSession(running.session, options.keepPrevViewed);
      } else {
        const next: Session = { ...session, initialRows: [] };
        applyLoadedSession(next, loaded);
        // 파일에 남은 제공자가 지금 빌드가 모르는 값이면 이전 것을 유지한다
        // (storage는 PROVIDERS를 못 보므로 검증은 여기서 한다)
        try {
          next.provider = normalizeProvider(next.provider);
        } catch {
          next.provider = session.provider;
          next.model = session.model;
        }
        setFocusedSession(next, options.keepPrevViewed);
      }
      // 복원한 설정은 이미 파일에 있으므로, 다음 변경 전까지 다시 적지 않는다
      persistedConfigs.set(session.sessionId, JSON.stringify(sessionConfigOf(session)));
      emitTo(session, { type: 'permission-mode', value: session.permissionMode });
      // 대화를 열면 그 대화가 시작된 탭으로 따라간다. 코딩 대화를 채팅 탭에서
      // 열면 이미 오간 도구 호출과 앞뒤가 안 맞는다
      tabMode = loaded.mode;
      // 이미 파일에 mode 엔트리가 있으므로 다시 적지 않는다
      recordedSessions.add(session.sessionId);
      setMode(loaded.mode);
      // 대화를 옮겨도 컨텍스트 게이지가 남아 있게 마지막 실측값을 되살린다.
      // 돌고 있는 턴이 있으면 그 턴의 최신값, 아니면 파일의 마지막 기록
      lastUsage =
        running?.usage ??
        (loaded.usage
          ? {
              cachedInputTokens: loaded.usage.cached,
              inputTokens: loaded.usage.input,
              outputTokens: loaded.usage.output,
            }
          : null);
      // 파일 내용 뒤에 아직 파일에 없는 행(진행 중인 턴의 행, 안 읽은 메시지)을 이어 붙인다
      emitTo(session, { type: 'rows:set', rows: [...loaded.rows, ...(unsavedRows.get(id) ?? [])] });
        emitViewState();
      emitSessionMeta();
      // 복원한 모델의 컨텍스트 창 크기로 게이지를 다시 맞춘다
      refreshContextWindow();
    } catch (error) {
      setAlert(`오류: ${errorMessage(error)}`);
    }
  }

  /**
   * 세션 객체를 얻는다 — 돌고 있는 턴이 쥔 살아있는 객체가 있으면 그것을(그 턴이
   * 계속 기록하므로), 없으면 파일에서 로드해 새 객체로 만든다. 파일 내용(loaded)도
   * 함께 돌려줘 화면 복원에 쓴다
   */
  function acquireSession(id: string): {
    obj: Session;
    loaded: ReturnType<typeof loadSessionById>;
  } {
    const projectPath = findSessionProjectPath(id);
    const loaded = loadSessionById(id, projectPath);
    const running = turns.get(id);
    if (running) return { obj: running.session, loaded };
    const next: Session = { ...session, initialRows: [] };
    applyLoadedSession(next, loaded);
    // 파일에 남은 제공자가 지금 빌드가 모르는 값이면 포커스 세션 것을 유지한다
    try {
      next.provider = normalizeProvider(next.provider);
    } catch {
      next.provider = session.provider;
      next.model = session.model;
    }
    return { obj: next, loaded };
  }

  /**
   * 화면 분할: 세션을 칸 하나에 추가로 띄운다 (포커스·cwd는 건드리지 않는다).
   * 그 칸이 대화 내용·헤더 정보를 받도록 상태를 내보낸다. 이미 다른 칸이 이
   * 세션을 보고 있으면 최신 상태만 다시 내보낸다
   */
  function openViewedSession(sessionId: string) {
    const id = String(sessionId);
    try {
      // 이미 메모리에 뜬 세션(다른 칸·포커스·진행 중 턴)은 파일에서 다시 읽지
      // 않는다 — 새 대화처럼 아직 파일이 없는 세션도 안전하게 칸에 띄운다
      const existing = viewed.get(id) ?? turns.get(id)?.session;
      const obj = existing ?? acquireSession(id).obj;
      const fileRows = existing ? tryLoadSessionRows(id, obj.projectPath) : loadSessionById(id, obj.projectPath).rows;
      viewed.set(id, obj);
      emitTo(obj, { type: 'rows:set', rows: [...fileRows, ...(unsavedRows.get(id) ?? [])] });
      emitTo(obj, { type: 'permission-mode', value: obj.permissionMode });
      emitTo(obj, { type: 'mode', value: obj.mode });
      emitViewState(obj);
      emitSessionMetaFor(obj);
    } catch (error) {
      setAlert(`오류: ${errorMessage(error)}`);
    }
  }

  // 파일이 있으면 그 세션의 행을, 없으면(새 대화 등) 빈 배열을 돌려준다
  function tryLoadSessionRows(id: string, projectPath: string): SessionRow[] {
    try {
      return loadSessionById(id, projectPath).rows;
    } catch {
      return [];
    }
  }

  /**
   * 화면 분할: 칸에서 세션을 내린다. 돌고 있는 턴은 끊지 않는다 — 백그라운드로
   * 계속 돌며 파일에 기록하고, 다시 열면 거울로 되살린다. 마지막 칸(포커스)은
   * 남긴다 — viewed가 비면 이벤트가 갈 곳이 없다
   */
  function closeViewedSession(sessionId: string) {
    const id = String(sessionId);
    if (viewed.size <= 1) return;
    // 포커스 칸을 닫을 때는 렌더러가 setFocus로 포커스를 먼저 옮긴 뒤 부른다
    if (id === session.sessionId) return;
    viewed.delete(id);
  }

  /**
   * 화면 분할: 포커스(전역 UI·설정·입력이 향하는 칸)를 옮긴다. 다른 칸은 그대로
   * 둔다 (keepPrevViewed). resumeSession이 tabMode·모드·설정 스냅샷·cwd·게이지를
   * 그 세션 기준으로 되살린다 — 그래서 입력을 그 칸으로 보내면 곧 이 세션 것이 된다
   */
  function setFocus(sessionId: string) {
    const id = String(sessionId);
    if (id === session.sessionId) return;
    const target = viewed.get(id) ?? turns.get(id)?.session;
    if (!target) {
      // 메모리에 없는(사이드바의 저장된) 세션이면 파일에서 열어 포커스한다
      resumeSession(id, { keepPrevViewed: true });
      return;
    }
    // 이미 칸에 떠 있는 세션 — 파일에서 다시 읽지 않는다. 새 대화처럼 아직 파일이
    // 없는 세션도 여기로 들어와 안전하게 포커스된다 (예전엔 loadSessionById가
    // "세션을 찾을 수 없습니다"로 죽었다). 대화 행은 칸이 이미 보여주고 있어
    // 다시 보내지 않고, 전역 UI(권한·모드·모델·워크스페이스)만 이 세션에 맞춘다
    cancelPendingApproval();
    if (target.projectPath !== process.cwd()) {
      try {
        process.chdir(target.projectPath);
      } catch {
        setAlert(`프로젝트 폴더를 열 수 없습니다: ${target.projectPath}`);
      }
    }
    setFocusedSession(target, true);
    lastUsage = turns.get(session.sessionId)?.usage ?? null;
    emitTo(session, { type: 'permission-mode', value: session.permissionMode });
    setMode(session.mode);
    tabMode = session.mode === 'chat' ? 'chat' : 'agent';
    emitViewState(session);
    emitSessionMetaFor(session);
    emitWorkspace();
    refreshContextWindow();
  }

  async function submit(text: string, images?: string[]) {
    const trimmed = String(text ?? '').trim();
    const attachedImages = sanitizeImages(images);
    if (!trimmed && attachedImages.length === 0) return;

    // 이 제출이 속한 세션. 턴이 도는 동안 화면이 다른 대화로 옮겨가도 이 객체에 기록한다
    const target = session;
    if (compactingSessions.has(target.sessionId)) {
      setNotice('대화를 압축하는 중입니다. 끝난 뒤 다시 보내 주세요.');
      return;
    }

    // 에이전트가 작업 중이면 줄을 세운다. 행은 지금 만들되 readAt 없이 — 화면에는
    // "안읽음"으로 보이다가 루프가 모델에게 넘기는 순간 읽은 시각이 찍힌다
    const running = turns.get(target.sessionId);
    if (running) {
      if (trimmed.startsWith('/')) {
        setNotice('작업 중에는 명령을 쓸 수 없습니다. 끝난 뒤 다시 보내 주세요.');
        return;
      }
      const at = new Date().toISOString();
      const id = appendRowTo(target, {
        at,
        role: 'user',
        content: trimmed,
        ...(attachedImages.length ? { images: attachedImages } : {}),
        persist: false,
      });
      running.pendingInterjections.push({ at, id, images: attachedImages, text: trimmed });
      return;
    }

    emitTo(target, { type: 'busy', value: true });
    try {
      // 첫 메시지에 이 대화가 어느 탭 것인지 남긴다. 사이드바가 탭별로 나누는 근거.
      // 설정(제공자·모델·추론 강도·권한 모드)도 이때 처음 적는다
      if (!recordedSessions.has(target.sessionId)) {
        recordedSessions.add(target.sessionId);
        recordSessionMode(target, target.mode === 'chat' ? 'chat' : 'agent');
        persistedConfigs.delete(target.sessionId);
        persistConfig(target);
      }

      const sentAt = new Date().toISOString();
      appendRowTo(target, {
        at: sentAt,
        // 보통의 메시지는 보내는 즉시 모델이 읽는다
        readAt: sentAt,
        role: 'user',
        content: trimmed,
        ...(attachedImages.length ? { images: attachedImages } : {}),
        persist: false,
      });

      const handled = await runSlashCommand(trimmed, {
        appendRow,
        compact: () => compactSessionNow(target),
        exit: quit,
        formatCommandHelp: formatSlashCommandHelp,
        session: target,
        setMode,
        setNotice,
        setPermissionMode: changePermissionMode,
        setRows: rows => emitTo(target, { type: 'rows:set', rows }),
      });
      if (handled) return;

      await runTurnChain(target, trimmed, attachedImages, { at: sentAt });
    } finally {
      // 이 세션을 아직 보고 있는 칸이 있으면 그 칸의 작업중 표시를 끈다
      emitTo(target, { type: 'busy', value: false });
      // 설정·세션메타는 포커스된(전역 UI가 가리키는) 세션 기준이다
      if (target.sessionId === session.sessionId) {
        // /provider, /model 같은 슬래시 명령은 세션을 직접 바꾸므로 여기서 기록을 맞춘다
        persistConfig();
        // /provider, /model, /resume 변경이 헤더·사이드바에 반영되도록 함께 보냄
        emitSessionMeta();
      }
    }
  }

  /**
   * 턴을 돌리고, 그 턴이 읽지 못한 것을 새 턴으로 잇는다.
   *
   * 마지막 라운드 도중 도착해 읽지 못한 끼어든 메시지는 바로 새 턴으로 잇는다.
   * 중단한 턴도 마찬가지 — 사용자가 써 둔 말을 안 읽은 채 남기지 않는다. 행은
   * 이미 화면에 있으므로 읽은 시각만 찍고, 여러 개면 한 턴에 묶는다.
   *
   * 백그라운드 보조 에이전트의 보고도 같다. 턴이 없는 동안 도착했거나 마지막
   * 라운드가 읽지 못한 보고는 자동 턴으로 넘긴다 — 한 번에 하나만 열고, 나머지는
   * 그 턴이 라운드 사이에 꺼내 간다
   */
  async function runTurnChain(
    target: Session,
    text: string,
    images: string[] = [],
    meta: { at?: string; readAt?: string; report?: Interjection; retry?: boolean } = {},
  ): Promise<void> {
    let leftover = await sendToAgent(target, text, images, meta);
    while (leftover.length > 0) {
      const batch = leftover;
      const readAt = new Date().toISOString();
      for (const item of batch) patchRowIn(target, item.id, { readAt });
      leftover = await sendToAgent(
        target,
        batch.map(item => item.text).join('\n\n'),
        batch.flatMap(item => item.images ?? []),
        { at: batch[0].at, readAt },
      );
    }
    const report = pendingReports.get(target.sessionId)?.shift();
    if (report) await runTurnChain(target, report.text, [], { at: report.at, report });
  }

  /**
   * 백그라운드 보조 에이전트의 보고가 도착했다. 행을 닫고, 모델에게 넘길 자동
   * 알림을 만든다. 부모 턴이 돌고 있으면 다음 라운드가 꺼내 가고, 없으면 자동
   * 턴을 연다. 사용자가 중단한 것은 알릴 보고가 아니라 행만 닫는다
   */
  function deliverAgentReport(target: Session, report: AgentReport) {
    backgroundAgents.get(target.sessionId)?.delete(report.callId);
    patchRowIn(target, `tool-${report.callId}`, {
      result: report.text,
      toolStatus: report.ok ? 'done' : 'error',
    });
    if (report.aborted) return;

    // 모델이 왜 갑자기 이어서 말하는지 사용자도 볼 수 있어야 한다
    appendRowTo(target, {
      id: randomUUID(),
      role: 'system',
      content: `보조 에이전트 보고 도착: ${report.description}`,
    });
    const head = report.ok
      ? `보조 에이전트 "${report.description}"이(가) 끝났습니다. 보고:`
      : `보조 에이전트 "${report.description}"이(가) 오류로 끝났습니다:`;
    const item: Interjection = {
      agentReport: {
        callId: report.callId,
        children: report.children,
        ok: report.ok,
        text: report.text,
      },
      at: new Date().toISOString(),
      automatic: true,
      id: `agent-report-${report.callId}`,
      text: `${AGENT_REPORT_NOTICE}\n${head}\n\n${report.text}`,
    };
    let queue = pendingReports.get(target.sessionId);
    if (!queue) {
      queue = [];
      pendingReports.set(target.sessionId, queue);
    }
    queue.push(item);
    if (!turns.get(target.sessionId)) void startAutomaticTurn(target);
  }

  /** 턴이 없는 세션에 보고가 도착했다. 자동 턴을 열어 모델에게 넘긴다 */
  async function startAutomaticTurn(target: Session) {
    // 화면이 이 대화를 다시 열어 세션 객체를 새로 만들었을 수 있다. 옛 객체에
    // 기록하면 그 뒤의 대화가 모델 이력에서 빠지므로 살아 있는 객체를 쓴다
    const live = session.sessionId === target.sessionId ? session : target;
    if (turns.get(live.sessionId)) return;
    const report = pendingReports.get(live.sessionId)?.shift();
    if (!report) return;

    emitTo(live, { type: 'busy', value: true });
    try {
      await runTurnChain(live, report.text, [], { at: report.at, report });
    } finally {
      emitTo(live, { type: 'busy', value: false });
      if (live.sessionId === session.sessionId) {
        persistConfig();
        emitSessionMeta();
      }
    }
  }

  /**
   * 에이전트 턴 하나. target 세션 객체를 끝까지 쥐고 돈다 — 도중에 화면이 다른
   * 대화로 옮겨가도 기록은 target에, 화면 이벤트는 target을 보고 있을 때만.
   * 돌려주는 값은 이 턴이 읽지 못한 끼어든 메시지 (호출자가 새 턴으로 잇는다).
   * meta.report가 있으면 사용자가 아니라 보조 에이전트 보고가 연 자동 턴이다
   */
  async function sendToAgent(
    target: Session,
    text: string,
    images: string[] = [],
    meta: { at?: string; readAt?: string; report?: Interjection; retry?: boolean } = {},
  ): Promise<Interjection[]> {
    let assistantRowId: string | null = null;
    let draft = '';
    let reasoningDraft = '';
    // 스트리밍 청크마다 화면을 갱신하면 렌더러가 청크마다 그 행의 마크다운과 코드
    // 하이라이트를 다시 계산해 스레드가 포화되고, 생성 중에는 스크롤 입력까지
    // 씹혔다. 청크는 초안에 모으고 화면 갱신은 주기로 묶어 보낸다. 행이 닫히거나
    // 턴이 끝날 때는 바로 흘려보내 마지막 내용이 늦게 덮어쓰는 일이 없게 한다
    let liveFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let liveTextDirty = false;
    let liveReasoningDirty = false;
    function flushLive() {
      if (liveFlushTimer) {
        clearTimeout(liveFlushTimer);
        liveFlushTimer = null;
      }
      if (!assistantRowId) {
        liveTextDirty = false;
        liveReasoningDirty = false;
        return;
      }
      // 미러는 청크마다 이미 맞춰 두었으므로 여기서는 화면 이벤트만 보낸다
      if (liveTextDirty) {
        liveTextDirty = false;
        emitTo(target, { type: 'row:update', id: assistantRowId, content: draft });
      }
      if (liveReasoningDirty) {
        liveReasoningDirty = false;
        emitTo(target, { type: 'row:patch', id: assistantRowId, patch: { reasoning: reasoningDraft } });
      }
    }
    // 세션을 오갈 때 진행 중인 행을 되살리는 미러는 지연 없이 맞춘다
    function mirrorLive(patch: Partial<SessionRow>) {
      const mirrored = assistantRowId ? mirrorOf(target).find(row => row.id === assistantRowId) : undefined;
      if (mirrored) Object.assign(mirrored, patch);
    }
    function scheduleLiveFlush() {
      if (!liveFlushTimer) liveFlushTimer = setTimeout(flushLive, LIVE_FLUSH_MS);
    }
    /*
     * 이번 턴에 이력으로 확정된 것들 (도구 라운드, 끼어든 메시지).
     *
     * 정상 종료면 runAgentTurn의 toolTurns와 같은 내용이라 쓰지 않는다. 중단으로
     * 예외가 나면 반환값이 없으므로, 여기 모인 것으로 "실제로 끝낸 만큼"을 남긴다
     */
    const settledTurns: SessionModelMessage[] = [];
    // 이번 턴에 루프가 이력을 접을 때마다 띄운 "압축 완료" 줄. 턴의 메시지를 파일에
    // 적은 뒤에 남긴다 — 먼저 적으면 다시 열었을 때 그 줄이 이번 턴보다 위에 그려진다
    const compactRows: SessionRow[] = [];
    const turn: Turn = {
      abort: new AbortController(),
      approval: null,
      deleted: false,
      interruptRound: null,
      pendingInterjections: [],
      session: target,
      spentOutput: 0,
      status: null,
      usage: null,
    };
    turns.set(target.sessionId, turn);
    const sentAt = meta.at ?? new Date().toISOString();
    const automatic = meta.report !== undefined;
    const userMessage = {
      ...(meta.report?.agentReport ? { agentReport: meta.report.agentReport } : {}),
      at: sentAt,
      ...(automatic ? { automatic: true } : {}),
      readAt: meta.readAt ?? sentAt,
      role: 'user' as const,
      content: text,
      ...(images.length ? { images } : {}),
    };
    target.messages.push(userMessage);
    // 다시 시도한 요청의 말풍선은 처음 실패했을 때 남겼다. 여기서는 이력으로만 남긴다
    const recordTurnPrompt = () =>
      recordSessionMessages(target, [userMessage], meta.retry ? 'retried' : undefined);
    const startedAt = Date.now();

    // 같은 라벨이면 다시 보내지 않음 (스트리밍 청크마다 IPC가 나가는 것을 방지)
    function setStatus(label: string) {
      if (turn.status?.label === label) return;
      turn.status = { label, startedAt };
      emitTo(target, { type: 'status', status: turn.status });
    }
    setStatus('생각 중...');

    // 답변 행은 첫 텍스트가 도착할 때 만들어서 도구 행보다 아래에 오게 함.
    // 도구 실행 후의 텍스트는 새 행으로 시작해 실행 순서가 그대로 보이게 함.
    function ensureAssistantRow() {
      if (!assistantRowId) {
        assistantRowId = randomUUID();
        draft = '';
        reasoningDraft = '';
        appendRowTo(target, { id: assistantRowId, role: 'assistant', content: '', persist: false });
      }
      return assistantRowId;
    }

    // 턴이 끝났을 때 OS 알림에 실을 본문 (성공이면 답변, 실패면 오류 메시지)
    let notifyBody = '';

    // 상태 줄의 실시간 토큰. 실측값은 라운드가 끝나야 오므로, 스트리밍 중에는
    // 글자 수로 추정해 올리다가(한국어 섞인 텍스트 기준 대략 3자/토큰) 라운드가
    // 끝나면 실측 누계로 스냅한다 — 추정이 없으면 숫자가 라운드 끝에만 팍 뛴다
    let liveOutputChars = 0;
    let lastTokensEmitAt = 0;
    function emitLiveTurnTokens() {
      if (!viewing(target)) return;
      const now = Date.now();
      if (now - lastTokensEmitAt < 300) return;
      lastTokensEmitAt = now;
      emitTo(target, { type: 'turn-tokens', used: turn.spentOutput + Math.round(liveOutputChars / 3) });
    }
    try {
      // 턴 전체를 이 세션의 프로젝트 폴더에 고정한다. 도중에 화면이 다른 프로젝트의
      // 대화로 옮겨가 process.cwd()가 바뀌어도, 이 턴의 도구는 끝까지 여기를 본다
      const { compaction, stop, text: assistantText, toolTurns, reasoning, stopReason } = await runInWorkdir(
        target.projectPath,
        async () => runAgentLoop(target, {
        output: {
          write(chunk) {
            ensureAssistantRow();
            draft += chunk;
            mirrorLive({ content: draft });
            liveTextDirty = true;
            scheduleLiveFlush();
            liveOutputChars += chunk.length;
            emitLiveTurnTokens();
            setStatus('답변 작성 중...');
          },
          // 추론 요약은 본문보다 먼저 오므로 같은 행을 먼저 만들어 그 위에 쌓는다.
          // 도구만 부르고 끝나는 라운드면 본문 없이 요약만 남은 행이 되고, 도구
          // 행이 그 아래 붙는다 — 실제 일어난 순서 그대로다
          writeReasoning(chunk) {
            ensureAssistantRow();
            reasoningDraft += chunk;
            mirrorLive({ reasoning: reasoningDraft });
            liveReasoningDirty = true;
            scheduleLiveFlush();
            liveOutputChars += chunk.length;
            emitLiveTurnTokens();
            setStatus('생각 중...');
          },
        },
        // 이력을 접었다는 사실은 화면에 남긴다. 조용히 접으면 모델이 앞을 잊은
        // 것처럼 보이고, 사용자는 원인을 알 방법이 없다. /compact와 같은 "압축 완료"
        // 줄로 그리고, 파일에는 턴의 메시지를 적은 뒤에 남긴다 (compactRows)
        onCompact({ brief, freedTokens }) {
          const row: SessionRow = {
            compact: { brief, freedTokens, state: 'done', trigger: 'auto' },
            content: '',
            id: randomUUID(),
            role: 'compact',
          };
          compactRows.push(row);
          appendRowTo(target, { ...row, persist: false });
        },
        onRound({ interrupt }) {
          turn.interruptRound = interrupt;
        },
        // "지금 보내기"로 라운드가 끊겼다. 쓰던 답변 행을 닫아, 다음 라운드의 글이
        // 사용자가 보낸 메시지 아래 새 행에서 시작하게 한다
        onRoundInterrupted() {
          flushLive();
          if (assistantRowId) patchRowIn(target, assistantRowId, { at: new Date().toISOString() });
          assistantRowId = null;
          setStatus('생각 중...');
        },
        onTurnMessage(message) {
          settledTurns.push(message);
        },
        takeInterjections() {
          // 보조 에이전트 보고를 먼저, 그 뒤에 사용자가 끼어든 말 — 사용자의 말이
          // 보고를 보고 한 말일 수 있다
          return [
            ...(pendingReports.get(target.sessionId)?.splice(0) ?? []),
            ...turn.pendingInterjections.splice(0),
          ];
        },
        onAgentStart({ abort, callId }) {
          let agents = backgroundAgents.get(target.sessionId);
          if (!agents) {
            agents = new Map();
            backgroundAgents.set(target.sessionId, agents);
          }
          agents.set(callId, abort);
        },
        onAgentReport(report) {
          deliverAgentReport(target, report);
        },
        onInterjectionRead(id, readAt) {
          patchRowIn(target, id, { readAt });
        },
        systemPrompt: await buildSystemPrompt(target),
        envContext: await buildTurnEnvContext(target),
        onTurnInputs(inputs) {
          // 측정은 화면이 컨텍스트 팝업을 열 때만 한다. 여기서는 무엇을 보냈는지만
          // 붙잡아 둔다 — 객체가 새로 만들어지는 것이 곧 "값이 바뀌었다"는 신호라
          // 캐시 무효화도 이걸로 한다
          lastTurnInputs = {
            model: target.model,
            provider: target.provider,
            systemPrompt: inputs.systemPrompt,
            tools: inputs.tools,
          };
        },
        onUsage(usage) {
          turn.usage = usage;
          // 라운드별 출력을 누계해 "이 턴에서 얼마나 쓰고 있는지"를 만든다.
          // 실측이 왔으니 이 라운드의 글자 수 추정은 버린다 (누계로 스냅)
          turn.spentOutput += usage.outputTokens;
          liveOutputChars = 0;
          // 게이지는 보고 있는 세션 것만. 다른 세션의 값이 덮으면 안 된다.
          // 라운드마다 실측값이 오므로 그대로 흘려보내 상태 줄·게이지가 턴 중에도
          // 살아 움직이게 한다 (예전에는 턴이 끝나야 갱신됐다)
          if (viewing(target)) {
            lastTokensEmitAt = Date.now();
            emitTo(target, { type: 'turn-tokens', used: turn.spentOutput });
          }
          // 컨텍스트 게이지(tokens)는 포커스된 세션 하나만 반영한다 — 다른 칸의
          // 값이 전역 게이지를 덮으면 안 된다
          if (target.sessionId === session.sessionId) {
            lastUsage = usage;
            emit({ type: 'tokens', tokens: getContextUsage() });
          }
        },
        // 한도에 걸려 기다리는 중임을 알린다. 안 알리면 멈춘 것처럼 보인다
        onRetry({ attempt, maxAttempts, status, waitMs }) {
          const reason = status === 429 ? '요청 한도' : `일시 오류 ${status}`;
          setStatus(
            `${reason}로 ${Math.ceil(waitMs / 1000)}초 대기 중... (${attempt}/${maxAttempts})`,
          );
        },
        onToolEvent(event) {
          // 보조 에이전트 안의 호출(parentId)은 부모의 답변 행과 상태 줄을 건드리지
          // 않는다. 자식은 백그라운드라 부모가 동시에 글을 쓰고 있을 수 있고, 부모
          // 턴이 끝난 뒤에도 이벤트가 온다
          const own = !event.parentId;
          if (event.phase === 'start') {
            if (own) {
              // 도구 앞에 쓴 텍스트 행은 여기서 완성된 것이다 — 시각을 찍고 닫는다
              flushLive();
              if (assistantRowId) {
                patchRowIn(target, assistantRowId, { at: new Date().toISOString() });
              }
              assistantRowId = null;
              // 상태 줄에 지금 도는 도구를 그대로 보여준다. "생각 중..."만 떠 있으면
              // 긴 라운드 동안 무슨 일이 벌어지는지 알 수 없다
              const statusTarget = toolRowTarget(event);
              setStatus(`${toolRowTitle(event)}${statusTarget ? ` · ${statusTarget}` : ''}`);
            }
            appendRowTo(target, {
              id: `tool-${event.id}`,
              role: 'tool',
              content: toolRowTitle(event),
              input: { ...event.input },
              name: event.name,
              // 서브에이전트 안의 호출은 그것을 띄운 행 아래에 중첩된다
              ...(event.parentId ? { parentId: `tool-${event.parentId}` } : {}),
              target: toolRowTarget(event),
              toolStatus: 'running',
              persist: false,
            });
            return;
          }
          // 막힌 호출은 start 이벤트 없이 done만 온다 (실행 자체를 안 했으므로).
          // 행이 아직 없으니 patch가 아니라 append로 만들어 준다
          if (event.blocked) {
            if (own) {
              flushLive();
              assistantRowId = null;
            }
            const rowId = `tool-${event.id}`;
            // 자동 모드가 막은 것(분류기 판정, 판정 못 함)만 사용자가 그 자리에서 허용할
            // 수 있다. 승인 창에서 사용자가 거절한 것은 이미 사용자가 정한 것이다. 보조
            // 에이전트 안의 호출은 허용 목록이 그 에이전트의 것이라 여기서 풀지 않는다
            const allowable =
              own &&
              Boolean(event.command) &&
              (event.blockedBy === 'policy' || event.blockedBy === 'unverified');
            if (allowable) {
              allowableBlocks.set(rowId, { command: String(event.command), sessionId: target.sessionId });
            }
            appendRowTo(target, {
              id: rowId,
              role: 'tool',
              content: toolRowTitle(event),
              input: { ...event.input },
              name: event.name,
              ...(event.parentId ? { parentId: `tool-${event.parentId}` } : {}),
              result: event.result,
              target: toolRowTarget(event),
              toolStatus: 'blocked',
              ...(allowable ? { allowable: true } : {}),
              persist: false,
            });
            if (own) setStatus('생각 중...');
            return;
          }
          // 백그라운드로 넘긴 도구(보조 에이전트)의 행은 보고가 올 때 닫는다
          // (deliverAgentReport). 지금 닫으면 "시작했다"가 결과로 보인다
          if (!event.background) {
            patchRowIn(target, `tool-${event.id}`, {
              ...(event.images?.length ? { images: event.images } : {}),
              result: event.result,
              toolStatus: event.ok ? 'done' : 'error',
            });
          }
          // 도구가 끝나면 다시 LLM 응답을 기다리는 상태
          if (own) setStatus('생각 중...');
        },
        // 승인은 턴에 매달아 둔다. 다른 세션을 보는 동안 걸리면 화면에는 안 뜨고,
        // 그 대화로 돌아왔을 때 다시 띄운다 (emitViewState)
        confirmToolUse(request) {
          const next = approvalChain.then(
            () =>
              new Promise<boolean>(resolve => {
                // 백그라운드 자식은 이 턴이 끝난 뒤에도 물을 수 있다. 그 세션에
                // 지금 도는 턴이 있으면 그쪽 슬롯에 걸고, 없으면 물을 곳이 없어
                // 거부한다 (자식은 차단 결과를 받고 이어간다)
                const live = turns.get(target.sessionId);
                if (!live) {
                  resolve(false);
                  return;
                }
                const payload = describeToolRequest(request);
                live.approval = { request: payload, resolve };
                emitTo(target, { type: 'approval', request: payload });
              }),
          );
          approvalChain = next.catch(() => false);
          return next;
        },
        signal: turn.abort.signal,
        }),
      );
      // 남은 초안을 먼저 내보내 최종 답이 늦은 갱신에 덮이지 않게 한다
      flushLive();
      // 삭제된 세션의 턴은 결과를 어디에도 남기지 않는다
      if (turn.deleted) return [];
      // 도구 라운드(toolTurns)까지 세션에 남겨 재시작 후에도 모델 컨텍스트와
      // 도구 이력 UI가 복원되게 함
      const finishedAt = new Date().toISOString();
      const answered = stop.cause === 'done';
      // 최종 답은 모델이 답을 끝낸 턴에만 남긴다. 다른 이유로 멈춘 턴의 마지막 문장은
      // 도구 라운드와 함께 이미 toolTurns에 있어, 또 남기면 같은 문장이 도구 호출 없이
      // 한 번 더 찍힌다 — 라운드 상한 시절 "확인하겠습니다"가 두 번 보이던 원인이다
      const finalMessages: SessionModelMessage[] = answered
        ? [
            {
              at: finishedAt,
              role: 'assistant',
              content: assistantText,
              ...(reasoning ? { reasoning } : {}),
              ...(stopReason ? { stopReason } : {}),
            },
          ]
        : [];
      // toolTurns에는 도구 라운드와 그 사이에 끼어든 사용자 메시지가 순서대로 들어 있다
      target.messages.push(...toolTurns, ...finalMessages);
      if (answered) {
        const finalRowId = ensureAssistantRow();
        updateRowIn(target, finalRowId, assistantText);
        patchRowIn(target, finalRowId, { at: finishedAt });
      } else if (assistantRowId) {
        patchRowIn(target, assistantRowId, { at: finishedAt });
      }
      // 출력 상한에 잘려 끝난 턴은 그 사실을 화면과 세션에 남긴다. 조용히 끝나면
      // 사용자는 모델이 일하다 말고 멈춘 것으로만 보이고, 원인을 되짚을 길이 없다
      if (answered && stopReason === 'length') {
        appendRowTo(target, {
          id: randomUUID(),
          role: 'system',
          content: '(응답이 출력 길이 상한에서 잘렸습니다)',
        });
      }
      notifyBody = answered ? assistantText : stopSummary(stop);
      recordTurnPrompt();
      recordSessionMessages(target, [...toolTurns, ...finalMessages]);
      for (const row of compactRows) recordSessionRow(target, row);
      // 멈춘 이유는 이번 턴의 메시지를 적은 뒤에 남긴다. 순서가 바뀌면 다시 열었을 때
      // 안내가 이번 턴의 프롬프트보다 위에 그려진다
      if (stop.cause === 'aborted') {
        appendRowTo(target, { id: randomUUID(), role: 'system', content: '(요청을 중단했습니다)' });
      } else if (stop.cause !== 'done') {
        if (stop.cause === 'denied') lastBlockedCalls.set(target.sessionId, stop.blocked ?? []);
        appendRowTo(target, {
          content: stopSummary(stop),
          id: randomUUID(),
          role: 'stop',
          stop: { ...(stop.blocked ? { blocked: stop.blocked } : {}), cause: stop.cause },
        });
      }
      // 이번 턴에 이력을 접었으면 접힌 자리를 세션 인덱스로 확정해 남긴다. 다음 턴과
      // 재시작 뒤에도 같은 자리에서 이어가고 다시 접지 않는다. 접힌 자리가 턴 안에서만
      // 쓴 임시 메시지(정체 재촉)면 세션에 없어 못 찾는데, 그때는 남기지 않고 다음
      // 턴에 한 번 다시 접는다
      if (compaction) {
        const folded = target.messages.indexOf(compaction.lastFolded);
        if (folded !== -1) {
          target.compaction = {
            foldedCount: folded + 1,
            prompts: compaction.prompts,
            summary: compaction.summary,
          };
          recordSessionCompaction(target, target.compaction);
        }
      }
      // 이 대화를 다시 열었을 때 게이지를 되살리려면 실측값도 남겨야 한다
      if (turn.usage) {
        recordSessionUsage(target, {
          cached: turn.usage.cachedInputTokens,
          input: turn.usage.inputTokens,
          output: turn.usage.outputTokens,
        });
      }
      // mock 대화는 메모리 로그에도 남기지 않음 (/distill 정리 대상 아님).
      // 자동 턴의 입력은 보조 에이전트 보고라 사용자의 말이 아니다 — 답변만 남긴다
      if (!target.mock) {
        if (!automatic) appendToLog('user', text);
        if (answered) appendToLog('assistant', assistantText);
        if (!automatic && isCorrectionMessage(text)) void distillCorrectionNow(target);
      }
      // 첫 턴이면 백그라운드로 제목을 지어 세션 이름으로 저장.
      // 실패하면 조용히 firstPrompt 폴백으로 남긴다 — 제목이 대화를 막으면 안 된다
      if (!automatic && shouldAutoTitleSession(target)) {
        void generateSessionTitle(target, { userText: text }).then(
          title => {
            if (!title || turn.deleted) return;
            try {
              renameSessionFile(target.sessionId, title, findSessionProjectPath(target.sessionId));
              emit({ type: 'sessions-changed' });
            } catch (error) {
              // 세션 파일이 사라진 경우 등 — 제목만 포기하되 원인은 남긴다
              console.warn('[autoTitle] 이름 저장 실패:', error);
            }
          },
        );
      }
    } catch (error) {
      flushLive();
      if (turn.deleted) return [];
      // 사용자가 중단한 것은 오류가 아니므로 문구를 구분함. 받아둔 텍스트는 남긴다
      const aborted = turn.abort.signal.aborted;
      if (aborted) {
        /*
         * 받다 만 답변은 그대로 assistant 행에 둬 마크다운 렌더링을 유지한다. 이
         * 초안은 아래에서 모델 이력에도 같은 내용으로 남는데(recordSessionMessages),
         * 다시 열 때 그 이력에서 행이 재구성되므로(loadSession) 여기서 role을
         * system으로 바꾸고 같은 내용을 recordSessionRow로 또 남기면 다시 열었을 때
         * 같은 답이 렌더링된 것과 안 된 것 두 벌로 겹쳐 보인다
         */
        if (assistantRowId) patchRowIn(target, assistantRowId, { at: new Date().toISOString() });
        notifyBody = draft || '(요청을 중단했습니다)';
        /*
         * 중단된 턴도 실제로 끝낸 만큼은 이력에 남긴다. settledTurns에는 호출과
         * 결과가 한 건으로 묶여 확정된 도구 라운드만 들어 있어 짝이 깨지지 않는다
         * — 도구 실행 도중 끊기면 그 라운드는 통째로 빠진다.
         *
         * 받다 만 답변은 내용이 있을 때만 넣는다. 빈 assistant 메시지를 남기면
         * 다음 요청에 빈 턴이 실려 나간다.
         */
        const partial: SessionModelMessage[] = draft.trim()
          ? [
              {
                at: new Date().toISOString(),
                role: 'assistant',
                content: draft,
                ...(reasoningDraft ? { reasoning: reasoningDraft } : {}),
              },
            ]
          : [];
        target.messages.push(...settledTurns, ...partial);
        // 이 턴의 사용자 메시지·도구 왕복·받다 만 답변을 먼저 파일에 남긴 뒤에
        // 중단 안내 행을 남긴다. 순서가 바뀌면(안내를 먼저 적으면) 파일에는
        // "이번 턴이 끝나기도 전에 중단 안내가 먼저 적힌" 모양이 되고,
        // loadSession은 그 순서 그대로 읽어 안내를 이번 턴의 프롬프트보다도
        // 위에 그려버린다
        recordTurnPrompt();
        recordSessionMessages(target, [...settledTurns, ...partial]);
        appendRowTo(target, { id: randomUUID(), role: 'system', content: '(요청을 중단했습니다)' });
      } else {
        /*
         * 오류로 끝난 턴. 도구 라운드를 하나도 끝내지 못했으면 사용자 메시지를 되돌리고
         * 다시 시도가 같은 입력을 그대로 다시 보낸다. 중단은 다시 보내지 않으므로
         * 되돌릴 이유가 없고, 되돌리면 화면에는 남아 있는 대화가 모델의 이력에서만
         * 사라져 다음 턴에서 맥락이 끊긴다.
         *
         * 라운드를 끝낸 뒤의 오류는 되돌리지 않는다. 같은 입력을 다시 보내면 끝낸 일을
         * 처음부터 되풀이하고(파일 수정과 명령 실행까지), 그동안 끝낸 라운드는 이력에서
         * 빠져 화면에만 남았다. 끝낸 만큼 이력에 남기고, 다시 시도는 이어서 하라는
         * 요청으로 보낸다
         */
        const continuation = settledTurns.length > 0;
        if (continuation) {
          target.messages.push(...settledTurns);
          recordTurnPrompt();
          recordSessionMessages(target, settledTurns);
        } else {
          target.messages.pop();
          // 되돌려도 말풍선은 남긴다. 파일에 없으면 다른 대화에 다녀왔을 때 사라지고,
          // 다시 시도는 보이지 않는 요청에 답하게 된다. 다시 시도가 또 실패했으면
          // 처음 실패 때 이미 남겼다
          if (!meta.retry) recordSessionMessages(target, [userMessage], 'failed');
        }
        // 분류는 제목·상세·조치 버튼을 정한다. 중단은 오류가 아니므로 거치지 않는다
        const info = classifyProviderError(error);
        const rowId = ensureAssistantRow();
        updateRowIn(target, rowId, info.title, 'error');
        patchRowIn(target, rowId, { errorDetail: info.detail, errorKind: info.kind });
        notifyBody = info.title;
        // 다시 시도가 보낼 입력을 붙잡아 둔다. 되돌린 경우엔 target.messages에서 사용자
        // 메시지를 빼냈으므로 여기 없으면 되살릴 길이 없다
        lastFailedTurns.set(
          target.sessionId,
          continuation ? { continuation: true, images: [], text: CONTINUE_PROMPT } : { images, text },
        );
        recordSessionRow(target, {
          id: assistantRowId ?? undefined,
          role: 'error',
          content: info.title,
          errorDetail: info.detail,
          errorKind: info.kind,
        });
      }
    } finally {
      if (turns.get(target.sessionId) === turn) turns.delete(target.sessionId);
      // 파일에 적힌 행은 거울에서 뺀다. 아직 안 읽은 끼어든 메시지 행만 남긴다
      markRowsSaved(target, new Set(turn.pendingInterjections.map(item => item.id)));
      turn.status = null;
      // 중단 등으로 끝났는데 승인이 걸려 있으면 거부로 흘려보낸다
      if (turn.approval) {
        const { resolve } = turn.approval;
        turn.approval = null;
        resolve(false);
      }
      emitTo(target, { type: 'status', status: null });
      emitTo(target, { type: 'turn-tokens', used: null });
      emitTo(target, { type: 'approval', request: null });
      // 턴 동안 에이전트가 브랜치를 바꾸거나 저장소를 새로 만들었을 수 있다.
      // 폴더 변경·브랜치 전환 UI를 거칠 때만 갱신하면, 도구로 바뀐 것은 칩에
      // 반영되지 않아 화면이 실제 상태와 어긋난 채로 남는다. 워크스페이스 칩은
      // 포커스된 세션 기준이므로 포커스 세션의 턴이 끝날 때만 갱신한다
      if (target.sessionId === session.sessionId) emitWorkspace();
      // 턴이 끝나 사용자를 기다린다 — OS 알림. 사용자가 직접 중단한 턴은 제외
      // (본인이 한 일이라 알릴 게 없다). 창이 앞에 있는지는 notify 쪽이 판단한다
      if (!turn.deleted && !turn.abort.signal.aborted) {
        notify?.({
          body: notifyBody.replace(/\s+/g, ' ').trim().slice(0, 120) || '답변이 도착했습니다',
          sessionId: target.sessionId,
          title: `답변 완료 · ${basename(target.projectPath)}`,
          viewing: viewing(target),
        });
      }
    }
    return turn.deleted ? [] : turn.pendingInterjections.splice(0);
  }

  // 승인 창의 허용/거부. 보고 있는 세션의 턴이 기다리고 있으면 그쪽에, 아니면
  // 턴이 승인을 기다리면 그 턴에, 아니면 UI가 직접 띄운 승인(워크트리 제거 등) 슬롯에 전달한다
  function resolveApproval(approved: boolean, sessionId?: string) {
    const target = resolveTarget(sessionId);
    const turn = turns.get(target.sessionId) ?? null;
    if (turn?.approval) {
      const { resolve } = turn.approval;
      turn.approval = null;
      emitTo(target, { type: 'approval', request: null });
      resolve(Boolean(approved));
      return;
    }
    if (!pendingApprovalResolve) return;
    const resolve = pendingApprovalResolve;
    pendingApprovalResolve = null;
    emit({ type: 'approval', request: null });
    resolve(Boolean(approved));
  }

  // 대화를 바꿀 때 UI 승인 슬롯만 거부로 흘려보낸다. 턴의 승인은 Turn.approval에
  // 그대로 남아, 그 대화로 돌아오면 다시 뜬다 (백그라운드에서 기다린다)
  function cancelPendingApproval() {
    if (!pendingApprovalResolve) return;
    const resolve = pendingApprovalResolve;
    pendingApprovalResolve = null;
    emit({ type: 'approval', request: null });
    resolve(false);
  }

  /**
   * 보고 있는 세션의 턴 중단 (렌더러의 중단 버튼·Esc). 다른 세션의 턴은 건드리지
   * 않는다. 턴이 끝난 뒤에도 돌고 있는 백그라운드 보조 에이전트가 있으면 함께 끊는다
   */
  function cancelTurn(sessionId?: string) {
    const target = resolveTarget(sessionId);
    const turn = turns.get(target.sessionId) ?? null;
    const stoppedAgents = abortBackgroundAgents(target.sessionId);
    if (!turn) {
      if (stoppedAgents > 0) setNotice('보조 에이전트를 중단했습니다.');
      return;
    }
    turn.abort.abort();
    if (turn.approval) {
      const { resolve } = turn.approval;
      turn.approval = null;
      emitTo(target, { type: 'approval', request: null });
      resolve(false);
    }
    setNotice('요청을 중단했습니다.');
  }

  function isTurnInFlight() {
    return currentTurn() !== null;
  }

  // 세션 복귀(앱 시작) 시 자동 실행: recall 알림 + 누적 로그가 있으면 distill 기억 정리
  async function startup() {
    refreshContextWindow();

    if (session.noMemory) return;

    // 시작 알림은 homeOnly로 표시 — 홈 화면에만 보이고 채팅 화면에서는 걸러짐
    const recall = getRecallSummary(session.noMemory);
    if (recall) appendRow({ role: 'system', content: recall, homeOnly: true, persist: false });

    // 제공자가 준비되지 않았으면 기억 정리는 반드시 실패한다. 그 실패 메시지가 정작
    // 필요한 안내를 덮어 버리므로 아예 시도하지 않는다
    if (startupNotice || session.mock || countUnprocessedLogFiles() < 1) return;

    appendRow({
      role: 'system',
      content: '💤 쌓인 대화 로그를 정리하는 중...',
      homeOnly: true,
      persist: false,
    });
    try {
      const result = await distillUnprocessedLogs(session);
      appendRow({ role: 'system', content: result.summary, homeOnly: true, persist: false });
    } catch (error) {
      setAlert(`기억 정리 오류: ${errorMessage(error)}`);
    }
  }

  return {
    allowBlockedCall,
    cancelTurn,
    changeWorkingDirectory,
    checkoutBranch,
    closeViewedSession,
    continueAfterStop,
    createWorktree,
    getContextBreakdown,
    getGitDiffFiles,
    getGitDiffSummary,
    getInitialState,
    getPreferences,
    getSessionList,
    interjectNow,
    isProviderReady,
    listBranches,
    listModels,
    listWorktreeEntries,
    newSession,
    newSessionIn,
    openViewedSession,
    removeSession,
    removeWorktreeEntry,
    renameSession,
    resolveApproval,
    resumeSession,
    resyncFocused,
    retryLastTurn,
    savePreferences,
    setFocus,
    setModel,
    setPermissionMode: changePermissionMode,
    setReasoningEffort,
    setTabMode,
    setProvider,
    startup,
    submit,
  };
}

/** 멈춘 턴을 잇거나 오류 뒤 다시 시도할 때 사용자 메시지로 보내는 말 */
const CONTINUE_PROMPT = '이어서 진행해 주세요.';

/**
 * 보조 에이전트 보고를 모델에게 넘기는 자동 알림의 머리말. user 역할로 들어가지만
 * 사용자가 쓴 말이 아니므로, 모델이 이 메시지 자체에 대답하지 않게 표식을 앞세운다
 */
const AGENT_REPORT_NOTICE =
  '[자동 알림 — 사용자가 보낸 메시지가 아닙니다. 이 메시지에 답하거나 이 메시지를 언급하지 말고, ' +
  '아래 보고를 바탕으로 하던 작업을 이어가세요.]';

// 첨부 이미지 검증: data URL 이미지 최대 4장, 각 ~7MB(base64 기준)
const MAX_IMAGES = 4;
const MAX_IMAGE_DATA_URL_CHARS = 10_000_000;

function sanitizeImages(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter(value => typeof value === 'string')
    .filter(value => /^data:image\//.test(value) && value.length <= MAX_IMAGE_DATA_URL_CHARS)
    .slice(0, MAX_IMAGES);
}

// 승인 화면에 실을 페이로드 미리보기 길이
const APPROVAL_PREVIEW_CHARS = 400;
// 라벨은 승인 바 한 줄에 들어가야 하므로 훨씬 짧게 자름
const APPROVAL_LABEL_CHARS = 120;
// MCP 도구 입력은 스크롤되는 detail 상자에서 전체를 확인하므로 상한만 안전장치로 둠
const APPROVAL_DETAIL_JSON_CHARS = 20_000;

function previewText(value: unknown, maxChars = APPROVAL_PREVIEW_CHARS): string {
  const text = String(value ?? '');
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n…(${text.length - maxChars}자 더)`
    : text;
}

// 승인 요청을 안내 문구로 변환함.
// 무엇을 실행·기록하는지 실제 내용까지 보여줘야 승인이 의미가 있으므로,
// 경로뿐 아니라 쓰려는 내용·명령을 detail로 함께 넘긴다.
function describeToolRequest({ name, input, reason = null }: ToolRequest) {
  // MCP 도구는 서버 이름만으로는 무엇을 승인하는지 알 수 없으므로 도구 이름을 라벨에 포함
  const mcp = parseMcpToolName(name);
  const label =
    name === 'run_command'
      ? `명령 실행 — ${String(input.command ?? '').trim()}`
      : mcp
        ? `${toolRowLabel(name)} · ${mcp.tool} — ${summarizeInput(input)}`
        : `${toolRowLabel(name)} — ${input.path ?? input.query ?? input.url ?? summarizeInput(input)}`;

  return { label, detail: buildApprovalDetail(name, input), reason: reason ?? null };
}

// MCP 도구처럼 페이로드가 객체 하나로 오는 경우의 라벨용 한 줄 요약
function summarizeInput(input: Record<string, string>): string {
  const text = JSON.stringify(input);
  return text.length > APPROVAL_LABEL_CHARS ? `${text.slice(0, APPROVAL_LABEL_CHARS)}…` : text;
}

function buildApprovalDetail(name: string, input: Record<string, string>): string {
  if (name === 'run_command') return previewText(input.command);
  if (name === 'edit_file') {
    return [
      '- 바꿀 내용',
      previewText(input.old_string),
      '+ 새 내용',
      previewText(input.new_string),
    ].join('\n');
  }
  if (name === 'create_file') return previewText(input.content);
  if (name === 'web_fetch') return String(input.url ?? '');
  // 자체 도구가 아니면(MCP 등) 입력 전체를 detail로 — 화면에서는 스크롤 상자에 담긴다
  return previewText(JSON.stringify(input, null, 2), APPROVAL_DETAIL_JSON_CHARS);
}
