import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentPanel } from './components/AgentPanel.tsx';
import { AlertPopup } from './components/AlertPopup.tsx';
import { ConfirmDialog } from './components/ConfirmDialog.tsx';
import { DiffPanel } from './components/DiffPanel.tsx';
import { MenuBar } from './components/MenuBar.tsx';
import { Pane } from './components/Pane.tsx';
import type { PaneState } from './components/Pane.tsx';
import { PaneGrid } from './components/PaneGrid.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { agentSiblings, collectChildren } from './components/Transcript.tsx';
import type {
  GitDiffSummary,
  InitialState,
  NewbieEvent,
  SessionSummary,
  TabMode,
  TranscriptRow,
  UpdateState,
  WorkspaceInfo,
} from './types.ts';

const MAX_ATTACHED_IMAGES = 4;
const MAX_PANES = 4;
const NOTICE_SHOW_MS = 5_000;
const SIDEBAR_WIDTH_KEY = 'newbie.sidebarWidth';
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 420;
const DIFF_PANEL_WIDTH_KEY = 'newbie.diffPanelWidth';
const DIFF_PANEL_MIN = 260;
const DIFF_PANEL_MAX = 760;

function loadSidebarWidth() {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (Number.isFinite(stored) && stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX) {
    return stored;
  }
  return 280;
}

function loadDiffPanelWidth() {
  const stored = Number(localStorage.getItem(DIFF_PANEL_WIDTH_KEY));
  if (Number.isFinite(stored) && stored >= DIFF_PANEL_MIN && stored <= DIFF_PANEL_MAX) {
    return stored;
  }
  return 380;
}

/** 화면 분할의 칸 — 어느 세션을 담고 있는지. paneId는 자리, sessionId는 내용 */
type PaneRef = { paneId: string; sessionId: string };

let paneSeq = 0;
function nextPaneId() {
  paneSeq += 1;
  return `pane-${paneSeq}`;
}

function emptyPaneState(): PaneState {
  return {
    rows: [],
    status: null,
    approval: null,
    busy: false,
    mode: 'agent',
    permissionMode: '',
    turnTokens: null,
    sessionMeta: null,
    tokens: null,
    attachedImages: [],
    attachedFiles: [],
  };
}

export function App() {
  const [initial, setInitial] = useState<InitialState | null>(null);
  // 화면 분할: 칸 목록(1~4)과 포커스된 칸, 그리고 세션별 상태 맵.
  // 칸이 하나뿐일 때는 예전과 똑같은 단일 화면이다
  const [panes, setPanes] = useState<PaneRef[]>([]);
  const [focusedPaneId, setFocusedPaneId] = useState('');
  const [paneStates, setPaneStates] = useState<Record<string, PaneState>>({});

  // 사이드바 탭(전역) — 포커스된 칸의 모드를 따라간다
  const [tabMode, setTabMode] = useState<TabMode>('agent');
  const [notice, setNotice] = useState('');
  const [alert, setAlert] = useState('');
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' });
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [diffSummary, setDiffSummary] = useState<GitDiffSummary | null>(null);
  const [diffPanelOpen, setDiffPanelOpen] = useState(false);
  const [diffPanelWidth, setDiffPanelWidth] = useState(loadDiffPanelWidth);
  const [agentPanelId, setAgentPanelId] = useState<string | null>(null);
  const seenAgents = useRef(new Set<string>());
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 홈 화면의 연결 안내에서 열면 제공자 탭부터 보여 준다
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'provider'>('general');
  const [providerReady, setProviderReady] = useState(true);
  const resizeState = useRef<{ startX: number; startWidth: number } | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // 사이드바에서 세션을 끌고 있는 중인지 — 칸의 드롭존을 띄우는 신호
  const [dragging, setDragging] = useState(false);
  // 지금 끄는 게 사이드바 세션(칸 추가용)인지 칸 헤더(자리 바꾸기용)인지 —
  // 드롭존 안내 문구를 그에 맞게 보여준다
  const [dragKind, setDragKind] = useState<'session' | 'pane' | null>(null);
  // 칸 자리 바꾸기(마우스 추적) 중 지금 커서가 올라가 있는 칸 — PaneGrid에 넘겨
  // 하이라이트한다. 네이티브 드래그가 아니라 dragenter/dragleave가 안 오므로 직접 추적
  const [reorderOverIndex, setReorderOverIndex] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{
    confirmLabel?: string;
    message: string;
    onConfirm: () => void;
    /** 파괴적이지 않은 확인(업데이트 받기 등)은 빨강 대신 강조색 */
    tone?: 'danger' | 'primary';
  } | null>(null);

  const refreshSessions = useCallback(() => {
    void window.newbie.sessions().then(setSessions);
  }, []);

  const refreshDiff = useCallback(() => {
    void window.newbie.gitDiffSummary().then(setDiffSummary);
  }, []);

  // 포커스된 칸의 세션 id — [] 의존성으로 한 번만 붙는 이벤트 핸들러가 최신 값을
  // 읽도록 ref로도 들고 있는다 (stale closure 방지)
  const focusedPane = panes.find(pane => pane.paneId === focusedPaneId) ?? panes[0] ?? null;
  const focusedSessionId = focusedPane?.sessionId ?? '';
  const focusedSessionIdRef = useRef(focusedSessionId);
  useEffect(() => {
    focusedSessionIdRef.current = focusedSessionId;
  }, [focusedSessionId]);

  // 어떤 세션의 상태를 함수로 갱신한다 — 그 세션을 담은 칸이 없으면(백그라운드
  // 전용) 무시한다. 새 칸을 열 때는 먼저 emptyPaneState로 자리를 만들어 둔다
  const updatePane = useCallback(
    (sessionId: string | undefined, fn: (state: PaneState) => PaneState) => {
      if (!sessionId) return;
      setPaneStates(previous =>
        previous[sessionId] ? { ...previous, [sessionId]: fn(previous[sessionId]) } : previous,
      );
    },
    [],
  );

  // 초기 상태 로드 + 이벤트 구독
  useEffect(() => {
    let disposed = false;
    void window.newbie.init().then(state => {
      if (disposed) return;
      setInitial(state);
      setProviderReady(state.providerReady);
      setTabMode(state.tabMode);
      setWorkspace(state.workspace);
      // 첫 칸: init이 준 세션 하나로 시작한다 (앱 시작은 항상 1칸)
      const paneId = nextPaneId();
      setPanes([{ paneId, sessionId: state.sessionId }]);
      setFocusedPaneId(paneId);
      setPaneStates({
        [state.sessionId]: {
          ...emptyPaneState(),
          rows: state.rows.map(ensureRowId),
          mode: state.mode,
          permissionMode: state.permissionMode,
          sessionMeta: {
            model: state.model,
            provider: state.provider,
            reasoningEffort: state.reasoningEffort,
          },
          tokens: state.tokens,
        },
      });
      refreshSessions();
      if (state.rows.some(row => row.role !== 'system')) refreshDiff();
      // 업데이트 확인은 init보다 먼저 끝났을 수 있다 — 이벤트를 놓쳤어도 여기서 받는다
      void window.newbie.updateState().then(setUpdate);
    });

    const unsubscribe = window.newbie.onEvent((event: NewbieEvent) => {
      switch (event.type) {
        case 'row:append':
          updatePane(event.sessionId, state => ({
            ...state,
            rows: [...state.rows, ensureRowId(event.row)],
          }));
          break;
        case 'row:update':
          updatePane(event.sessionId, state => ({
            ...state,
            rows: state.rows.map(row =>
              row.id === event.id
                ? {
                    ...row,
                    content: event.content,
                    role: (event.role ?? row.role) as TranscriptRow['role'],
                  }
                : row,
            ),
          }));
          break;
        case 'row:patch':
          updatePane(event.sessionId, state => ({
            ...state,
            rows: state.rows.map(row =>
              row.id === event.id ? { ...row, ...event.patch } : row,
            ),
          }));
          break;
        case 'rows:set':
          updatePane(event.sessionId, state => ({
            ...state,
            rows: event.rows.map(ensureRowId),
          }));
          break;
        case 'status':
          updatePane(event.sessionId, state => ({ ...state, status: event.status }));
          break;
        case 'turn-tokens':
          updatePane(event.sessionId, state => ({ ...state, turnTokens: event.used }));
          break;
        case 'approval':
          updatePane(event.sessionId, state => ({ ...state, approval: event.request }));
          break;
        case 'busy':
          updatePane(event.sessionId, state => ({ ...state, busy: event.value }));
          // 턴이 끝나면 세션 목록(첫 메시지·수정 시각)·파일 변경이 달라졌을 수 있음
          if (!event.value) {
            refreshSessions();
            refreshDiff();
          }
          break;
        case 'mode':
          updatePane(event.sessionId, state => ({ ...state, mode: event.value }));
          // 사이드바 탭은 포커스된 칸의 모드를 따라간다
          if (
            event.sessionId === focusedSessionIdRef.current &&
            (event.value === 'chat' || event.value === 'agent')
          ) {
            setTabMode(event.value);
          }
          break;
        case 'permission-mode':
          updatePane(event.sessionId, state => ({ ...state, permissionMode: event.value }));
          break;
        case 'session-meta':
          updatePane(event.sessionId, state => ({
            ...state,
            sessionMeta: {
              model: event.model,
              provider: event.provider,
              reasoningEffort: event.reasoningEffort,
            },
            tokens: event.tokens ?? state.tokens,
          }));
          // 모델 칩에서 키가 필요 없는 제공자로 바꿔도 준비 상태가 달라진다
          void window.newbie.providerReady().then(setProviderReady);
          break;
        case 'sessions-changed':
          refreshSessions();
          break;
        case 'tokens':
          // 컨텍스트 게이지는 포커스된 세션 하나만 — 이벤트에 sessionId가 없다
          updatePane(focusedSessionIdRef.current, state => ({ ...state, tokens: event.tokens }));
          break;
        case 'notice':
          setNotice(event.text);
          break;
        case 'update':
          setUpdate(event.state);
          break;
        case 'alert':
          setAlert(event.text);
          break;
        case 'workspace':
          setWorkspace(event.workspace);
          // 대화가 없는 첫 화면에는 변경량을 보이지 않으므로 계산하지 않는다.
          // 탭 전환·새 대화마다 이 이벤트가 오는데, 그때마다 git 비교를 돌렸다
          if (hasConversation(focusedSessionIdRef.current)) refreshDiff();
          break;
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [refreshSessions, refreshDiff, updatePane]);

  const focusedState = focusedSessionId ? paneStates[focusedSessionId] : undefined;
  // 사이드바 마스코트는 화면 분할 중 어느 칸이든 돌고 있으면 말하는 모습이 된다
  const anyPaneBusy = panes.some(pane => paneStates[pane.sessionId]?.busy);

  // 보조 에이전트 패널·diff는 전역이라 포커스된 칸의 대화를 기준으로 본다
  const focusedRows = focusedState?.rows ?? EMPTY_ROWS;
  const childRows = useMemo(() => collectChildren(focusedRows), [focusedRows]);
  const agentPanelRow = useMemo(
    () => (agentPanelId ? focusedRows.find(row => row.id === agentPanelId) ?? null : null),
    [agentPanelId, focusedRows],
  );

  // 같은 턴에 함께 뜬 에이전트들 — 패널에서 (1/2)와 이동 버튼을 그리는 재료
  const agentPanelSiblings = useMemo(
    () => (agentPanelRow ? agentSiblings(focusedRows, agentPanelRow) : []),
    [agentPanelRow, focusedRows],
  );

  const openAgentPanel = useCallback((id: string) => {
    setAgentPanelId(previous => (previous === id ? null : id));
    setDiffPanelOpen(false);
  }, []);

  // 보조 에이전트가 새로 뜨면 패널을 자동으로 연다 (포커스된 칸 기준)
  useEffect(() => {
    for (const row of focusedRows) {
      if (row.role !== 'tool' || row.name !== 'spawn_agent') continue;
      if (row.toolStatus !== 'running' || seenAgents.current.has(row.id)) continue;
      seenAgents.current.add(row.id);
      setAgentPanelId(row.id);
      setDiffPanelOpen(false);
    }
  }, [focusedRows]);

  // 알림은 잠시 보여주고 지움
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), NOTICE_SHOW_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // 승인 대기 중에는 y/n/Esc 키를 전역에서 받음 (포커스된 칸의 승인 대상)
  const focusedApproval = focusedState?.approval ?? null;
  const focusedBusy = focusedState?.busy ?? false;
  useEffect(() => {
    if (!focusedApproval) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'y' || event.key === 'Y') {
        event.preventDefault();
        window.newbie.approve(true, focusedSessionId);
      } else if (event.key === 'n' || event.key === 'N' || event.key === 'Escape') {
        event.preventDefault();
        window.newbie.approve(false, focusedSessionId);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusedApproval, focusedSessionId]);

  // 처리 중 Esc로 턴 중단 (승인 대기 중에는 위 핸들러의 거부가 우선)
  useEffect(() => {
    if (!focusedBusy || focusedApproval) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      window.newbie.cancel(focusedSessionId);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusedBusy, focusedApproval, focusedSessionId]);

  // ── 칸(pane) 조작 ────────────────────────────────

  const focusPane = useCallback(
    (paneId: string) => {
      setFocusedPaneId(current => {
        if (current === paneId) return current;
        const target = panesRef.current.find(pane => pane.paneId === paneId);
        if (target) window.newbie.setFocus(target.sessionId);
        return paneId;
      });
    },
    [],
  );

  // panes를 콜백 안에서 최신으로 읽기 위한 ref
  const panesRef = useRef<PaneRef[]>([]);
  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);
  const paneStatesRef = useRef<Record<string, PaneState>>({});
  // 대화가 시작된 세션인가. 입력창 아래 폴더 칩이 잠기는 기준과 같다 (Pane)
  function hasConversation(sessionId: string | null): boolean {
    const rows = sessionId ? paneStatesRef.current[sessionId]?.rows : undefined;
    return rows?.some(row => row.role !== 'system') ?? false;
  }
  useEffect(() => {
    paneStatesRef.current = paneStates;
  }, [paneStates]);

  const focusExistingPane = useCallback((sessionId: string) => {
    const target = panesRef.current.find(pane => pane.sessionId === sessionId);
    if (!target) return;
    setFocusedPaneId(target.paneId);
    window.newbie.setFocus(sessionId);
  }, []);

  // 드래그로 놓은 자리에 새 칸을 연다 (최대 4칸). 놓은 자리가 이미 다른 칸이면
  // 그 자리엔 새 세션이 들어가고, 원래 있던 세션은 새로 생기는 자리(끝)로 밀려난다
  const addPaneWithSessionAt = useCallback(
    (index: number, sessionId: string) => {
      if (panesRef.current.some(pane => pane.sessionId === sessionId)) {
        focusExistingPane(sessionId);
        return;
      }
      if (panesRef.current.length >= MAX_PANES) {
        setNotice(`최대 ${MAX_PANES}칸까지 나눌 수 있어요.`);
        return;
      }
      const paneId = nextPaneId();
      setPaneStates(previous =>
        previous[sessionId] ? previous : { ...previous, [sessionId]: emptyPaneState() },
      );
      setPanes(previous => {
        const displaced = previous[index];
        const newPane = { paneId, sessionId };
        if (!displaced) return [...previous, newPane];
        const next = [...previous];
        next[index] = newPane;
        next.push(displaced);
        return next;
      });
      setFocusedPaneId(paneId);
      window.newbie.openViewedSession(sessionId);
      window.newbie.setFocus(sessionId);
    },
    [focusExistingPane],
  );

  // 칸 헤더를 끌어다 다른 칸(또는 빈 자리)에 놓아 자리를 바꾼다. 기존 칸끼리는
  // 서로 맞바뀌고, 빈 자리(고스트)로 옮기면 그냥 맨 끝으로 이동한다 — 어느 쪽도
  // 세션 자체는 건드리지 않으니 백엔드에 알릴 것이 없다
  const reorderPanes = useCallback((fromPaneId: string, toIndex: number) => {
    setPanes(previous => {
      const fromIndex = previous.findIndex(pane => pane.paneId === fromPaneId);
      if (fromIndex === -1 || fromIndex === toIndex) return previous;
      const next = [...previous];
      if (toIndex >= previous.length) {
        const [moved] = next.splice(fromIndex, 1);
        next.push(moved);
        return next;
      }
      [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
      return next;
    });
  }, []);

  // 칸 헤더 드래그로 자리 바꾸기 — 네이티브 HTML5 드래그(draggable)는 이 안에서
  // react-resizable-panels가 게터 근처 포인터다운을 리사이즈 시도로 가로채거나
  // (자체 pointerdown 캡처 리스너) 브라우저의 제스처 인식과 얽혀 안정적으로
  // 시작되지 않았다. 그래서 마우스 이벤트를 직접 추적하는 방식으로 구현한다 —
  // 어디서든 항상 똑같이 동작한다
  const startPaneReorder = useCallback(
    (fromPaneId: string, startEvent: React.MouseEvent) => {
      startEvent.preventDefault();
      const startX = startEvent.clientX;
      const startY = startEvent.clientY;
      let moved = false;
      function paneIndexAt(x: number, y: number): number | null {
        const target = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(
          '[data-pane-index]',
        );
        if (!target) return null;
        const index = Number(target.dataset.paneIndex);
        return Number.isNaN(index) ? null : index;
      }
      function onMove(event: MouseEvent) {
        if (!moved && (Math.abs(event.clientX - startX) > 4 || Math.abs(event.clientY - startY) > 4)) {
          moved = true;
          setDragKind('pane');
          setDragging(true);
        }
        if (moved) {
          const index = paneIndexAt(event.clientX, event.clientY);
          setReorderOverIndex(previous => (previous === index ? previous : index));
        }
      }
      function onUp(event: MouseEvent) {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        setDragging(false);
        setDragKind(null);
        setReorderOverIndex(null);
        if (!moved) return;
        const toIndex = paneIndexAt(event.clientX, event.clientY);
        if (toIndex !== null) reorderPanes(fromPaneId, toIndex);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [reorderPanes],
  );

  // 칸의 세션을 교체한다 (사이드바 클릭·가운데 드롭). 이전 세션이 다른 칸에
  // 없으면 백엔드 뷰에서도 내린다 (돌던 턴은 백그라운드로 계속)
  const changePaneSession = useCallback((paneId: string, sessionId: string) => {
    const current = panesRef.current;
    if (current.some(pane => pane.sessionId === sessionId)) {
      focusExistingPane(sessionId);
      return;
    }
    const target = current.find(pane => pane.paneId === paneId);
    if (!target) return;
    const oldSessionId = target.sessionId;
    setPaneStates(previous => {
      const next = { ...previous };
      if (!next[sessionId]) next[sessionId] = emptyPaneState();
      // 이전 세션이 다른 칸에 없으면 상태도 버린다
      if (!current.some(pane => pane.paneId !== paneId && pane.sessionId === oldSessionId)) {
        delete next[oldSessionId];
      }
      return next;
    });
    setPanes(previous =>
      previous.map(pane => (pane.paneId === paneId ? { paneId, sessionId } : pane)),
    );
    setFocusedPaneId(paneId);
    window.newbie.openViewedSession(sessionId);
    window.newbie.setFocus(sessionId);
    if (!current.some(pane => pane.paneId !== paneId && pane.sessionId === oldSessionId)) {
      window.newbie.closeViewedSession(oldSessionId);
    }
  }, [focusExistingPane]);

  const closePane = useCallback((paneId: string) => {
    const current = panesRef.current;
    if (current.length <= 1) return;
    const target = current.find(pane => pane.paneId === paneId);
    if (!target) return;
    const remaining = current.filter(pane => pane.paneId !== paneId);
    const stillUsed = remaining.some(pane => pane.sessionId === target.sessionId);
    setPanes(remaining);
    if (!stillUsed) {
      setPaneStates(previous => {
        const next = { ...previous };
        delete next[target.sessionId];
        return next;
      });
      window.newbie.closeViewedSession(target.sessionId);
    }
    // 포커스된 칸을 닫았으면 남은 첫 칸으로 포커스를 옮긴다
    setFocusedPaneId(currentFocus => {
      if (currentFocus !== paneId) return currentFocus;
      const nextFocus = remaining[0];
      if (nextFocus) window.newbie.setFocus(nextFocus.sessionId);
      return nextFocus?.paneId ?? '';
    });
  }, []);

  // 백엔드가 만든 새 세션을 포커스된 칸에 묶는다 (새 대화·탭 전환 공용). 백엔드가
  // 이전 포커스 세션을 뷰에서 내렸으므로, 다른 칸이 안 쓰면 상태도 버린다
  const adoptFocusedPaneSession = useCallback((id: string) => {
    const paneId = focusedPaneIdRef.current;
    const target = panesRef.current.find(pane => pane.paneId === paneId);
    const oldSessionId = target?.sessionId;
    if (!id || oldSessionId === id) return;
    setPaneStates(previous => {
      const next = { ...previous, [id]: previous[id] ?? emptyPaneState() };
      if (
        oldSessionId &&
        oldSessionId !== id &&
        !panesRef.current.some(pane => pane.paneId !== paneId && pane.sessionId === oldSessionId)
      ) {
        delete next[oldSessionId];
      }
      return next;
    });
    setPanes(previous =>
      previous.map(pane => (pane.paneId === paneId ? { paneId, sessionId: id } : pane)),
    );
  }, []);

  // 행 컴포넌트가 memo라 새 함수를 매번 내리면 모든 행이 다시 그려진다
  const openSettings = useCallback(() => {
    setSettingsInitialTab('general');
    setSettingsOpen(true);
  }, []);
  const openProviderSettings = useCallback(() => {
    setSettingsInitialTab('provider');
    setSettingsOpen(true);
  }, []);

  // 사이드바 업데이트 줄. 받기와 설치 모두 사용자가 확인해야 진행된다 — 모르는
  // 사이 앱이 바뀌는 것이 불안하다는 피드백에서 자동 받기를 뺐다
  const onUpdateAction = useCallback(() => {
    if (update.phase === 'available' || update.phase === 'error') {
      setConfirm({
        confirmLabel: '받기',
        message: `Newbie ${update.version} 업데이트를 받을까요?`,
        onConfirm: () => {
          void window.newbie.updateDownload().then(setUpdate);
        },
        tone: 'primary',
      });
    } else if (update.phase === 'downloaded') {
      setConfirm({
        confirmLabel: '다시 시작',
        message: `Newbie ${update.version}을 설치하려면 앱을 다시 시작해야 해요. 지금 할까요? 나중에 해도 앱을 닫을 때 설치돼요.`,
        onConfirm: () => window.newbie.updateInstall(),
        tone: 'primary',
      });
    }
  }, [update]);

  // 새 대화: 포커스된 칸에 새 세션을 연다. 칸을 새 세션에 묶은 "뒤" resyncFocused로
  // 그 세션의 설정을 다시 받는다 (칸이 묶이기 전 지나간 이벤트 보정)
  const newSessionInFocusedPane = useCallback(async () => {
    const id = await window.newbie.newSession();
    if (!id) return;
    adoptFocusedPaneSession(id);
    window.newbie.resyncFocused();
  }, [adoptFocusedPaneSession]);

  const newSessionInFolder = useCallback(
    async (path: string) => {
      const id = await window.newbie.newSessionIn(path);
      if (!id) return;
      adoptFocusedPaneSession(id);
      window.newbie.resyncFocused();
    },
    [adoptFocusedPaneSession],
  );

  // 탭 전환: 새 세션을 만들고(백엔드) 포커스 칸에 묶은 뒤 사이드바 탭을 맞춘다
  const switchTab = useCallback(
    async (next: TabMode) => {
      const id = await window.newbie.setTabMode(next);
      if (!id) return;
      adoptFocusedPaneSession(id);
      setTabMode(next);
      window.newbie.resyncFocused();
    },
    [adoptFocusedPaneSession],
  );

  const focusedPaneIdRef = useRef(focusedPaneId);
  useEffect(() => {
    focusedPaneIdRef.current = focusedPaneId;
  }, [focusedPaneId]);

  // ── 칸별 입력·이미지 ──────────────────────────────

  const submitFromPane = useCallback((sessionId: string, text: string) => {
    const pane = paneStatesRef.current[sessionId];
    // 문서는 내용이 아니라 경로를 본문에 붙인다. 모델은 경로를 보고 read_file이나
    // parse_document로 읽는다 — 화면과 세션 기록에도 무엇을 첨부했는지 그대로 남는다
    const files = pane?.attachedFiles ?? [];
    const body = files.length
      ? [text, '첨부 파일:', ...files.map(path => `- ${path}`)].filter(Boolean).join('\n')
      : text;
    window.newbie.submit(body, pane?.attachedImages ?? []);
    updatePane(sessionId, state => ({ ...state, attachedImages: [], attachedFiles: [] }));
  }, [updatePane]);

  const attachImagesToPane = useCallback(
    (sessionId: string, files: Iterable<File>) => {
      for (const file of files) {
        if (!file.type.startsWith('image/')) {
          // 붙여넣기로 온 File은 경로가 없어 빈 문자열이 온다
          const path = window.newbie.pathForFile(file);
          if (!path) continue;
          updatePane(sessionId, state =>
            state.attachedFiles.includes(path)
              ? state
              : { ...state, attachedFiles: [...state.attachedFiles, path] },
          );
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result !== 'string') return;
          updatePane(sessionId, state =>
            state.attachedImages.length >= MAX_ATTACHED_IMAGES
              ? state
              : { ...state, attachedImages: [...state.attachedImages, reader.result as string] },
          );
        };
        reader.readAsDataURL(file);
      }
    },
    [updatePane],
  );

  // Ctrl+N 새 대화, Ctrl+W 창 닫기
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        void newSessionInFocusedPane();
      } else if (event.key === 'w' || event.key === 'W') {
        event.preventDefault();
        window.newbie.windowControl('close');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [newSessionInFocusedPane]);

  // 사이드바 리사이즈 핸들 드래그
  const onResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      resizeState.current = { startX: event.clientX, startWidth: sidebarWidth };

      function onMove(move: MouseEvent) {
        if (!resizeState.current) return;
        const next = Math.min(
          SIDEBAR_MAX,
          Math.max(
            SIDEBAR_MIN,
            resizeState.current.startWidth + move.clientX - resizeState.current.startX,
          ),
        );
        setSidebarWidth(next);
      }

      function onUp() {
        resizeState.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        setSidebarWidth(width => {
          localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
          return width;
        });
      }

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sidebarWidth],
  );

  // diff 패널 리사이즈 — 패널이 오른쪽이라 마우스를 왼쪽으로 끌수록 넓어짐
  const onDiffResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const start = { startX: event.clientX, startWidth: diffPanelWidth };

      function onMove(move: MouseEvent) {
        const next = Math.min(
          DIFF_PANEL_MAX,
          Math.max(DIFF_PANEL_MIN, start.startWidth - (move.clientX - start.startX)),
        );
        setDiffPanelWidth(next);
      }

      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        setDiffPanelWidth(width => {
          localStorage.setItem(DIFF_PANEL_WIDTH_KEY, String(width));
          return width;
        });
      }

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [diffPanelWidth],
  );

  if (!initial || panes.length === 0) {
    return <div className="app-loading">Newbie를 깨우는 중...</div>;
  }

  // 사이드바에는 지금 탭의 대화만 올린다
  const tabSessions = sessions.filter(session => session.mode === tabMode);
  const showHeaders = panes.length > 1;

  function sessionNameOf(sessionId: string): string {
    const summary = sessions.find(session => session.sessionId === sessionId);
    return summary?.name || summary?.firstPrompt || '새 대화';
  }

  return (
    <div className="app">
      <div className="topbar">
        <MenuBar onNewSession={() => void newSessionInFocusedPane()} />
        <button
          aria-label="사이드바 접기/펼치기"
          className="topbar-button"
          onClick={() => setSidebarCollapsed(previous => !previous)}
          type="button"
        >
          <svg fill="none" height="16" viewBox="0 0 16 16" width="16">
            <rect
              height="11"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.3"
              width="13"
              x="1.5"
              y="2.5"
            />
            <line stroke="currentColor" strokeWidth="1.3" x1="6" x2="6" y1="2.5" y2="13.5" />
          </svg>
        </button>
        <span className="topbar-drag" />
      </div>

      <div className="app-body">
        {!sidebarCollapsed && (
          <>
            <Sidebar
              currentSessionId={focusedSessionId}
              onDeleteSession={id => {
                setConfirm({
                  confirmLabel: '삭제',
                  message: '이 대화를 삭제할까요? 되돌릴 수 없습니다.',
                  onConfirm: () => {
                    void window.newbie.deleteSession(id).then(setSessions);
                  },
                });
              }}
              onNewSession={() => void newSessionInFocusedPane()}
              onNewSessionIn={path => void newSessionInFolder(path)}
              onRenameSession={(id, name) => {
                void window.newbie.renameSession(id, name).then(setSessions);
              }}
              onResumeSession={id => changePaneSession(focusedPaneId, id)}
              onSessionDragEnd={() => setDragging(false)}
              onSessionDragStart={() => {
                setDragKind('session');
                setDragging(true);
              }}
              onSetTabMode={next => void switchTab(next)}
              onToggleSettings={() => setSettingsOpen(previous => !previous)}
              onUpdateAction={onUpdateAction}
              sessions={tabSessions}
              tabMode={tabMode}
              talking={anyPaneBusy}
              update={update}
              width={sidebarWidth}
            />
            <div className="sidebar-resizer" onMouseDown={onResizeStart} />
          </>
        )}

        <div className="main">
          <PaneGrid
            count={panes.length}
            dragKind={dragKind}
            dragging={dragging}
            focusedIndex={panes.findIndex(pane => pane.paneId === focusedPaneId)}
            reorderOverIndex={reorderOverIndex}
            maxPanes={MAX_PANES}
            onAdd={(index, id) => {
              setDragging(false);
              addPaneWithSessionAt(index, id);
            }}
            onFocusSlot={index => {
              const pane = panes[index];
              if (pane) focusPane(pane.paneId);
            }}
            onReplace={(index, id) => {
              setDragging(false);
              const pane = panes[index];
              if (pane) changePaneSession(pane.paneId, id);
            }}
            renderPane={index => {
              const pane = panes[index];
              if (!pane) return null;
              const state = paneStates[pane.sessionId] ?? emptyPaneState();
              const isFocused = pane.paneId === focusedPaneId;
              return (
                <Pane
                  // 세션 id로 키를 준다 — 칸(index) 재배치·교체 때마다 리액트가
                  // 다른 세션인데 같은 인스턴스를 재사용하지 않도록. 안 그러면
                  // InputBar textarea의 인라인 height(JS가 DOM에 직접 쓴 값이라
                  // 리액트가 리셋 못 함)가 이전 세션 것 그대로 새 세션 칸에 남는다
                  key={pane.sessionId}
                  agentActiveId={agentPanelRow?.id ?? null}
                  diffSummary={isFocused ? diffSummary : null}
                  initial={initial}
                  notice={isFocused ? notice : ''}
                  onAttachImages={files => attachImagesToPane(pane.sessionId, files)}
                  onClose={() => closePane(pane.paneId)}
                  onHeaderMouseDown={event => startPaneReorder(pane.paneId, event)}
                  onOpenAgent={openAgentPanel}
                  onOpenDiff={() => {
                    setDiffPanelOpen(open => !open);
                    setAgentPanelId(null);
                  }}
                  onOpenProviderSettings={openProviderSettings}
                  onOpenSettings={openSettings}
                  onRemoveFile={fileIndex =>
                    updatePane(pane.sessionId, s => ({
                      ...s,
                      attachedFiles: s.attachedFiles.filter((_, i) => i !== fileIndex),
                    }))
                  }
                  onRemoveImage={imageIndex =>
                    updatePane(pane.sessionId, s => ({
                      ...s,
                      attachedImages: s.attachedImages.filter((_, i) => i !== imageIndex),
                    }))
                  }
                  onSetModel={name => window.newbie.setModel(name)}
                  onSetPermissionMode={value => window.newbie.setPermissionMode(value)}
                  onSetProvider={name => window.newbie.setProvider(name)}
                  onSetReasoningEffort={value => window.newbie.setReasoningEffort(value)}
                  onSubmit={text => submitFromPane(pane.sessionId, text)}
                  providerReady={providerReady}
                  sessionName={sessionNameOf(pane.sessionId)}
                  showHeader={showHeaders}
                  state={state}
                  workspace={isFocused ? workspace : null}
                />
              );
            }}
          />

          {agentPanelRow ? (
            <>
              <div className="sidebar-resizer" onMouseDown={onDiffResizeStart} />
              <AgentPanel
                childRows={childRows}
                onClose={() => setAgentPanelId(null)}
                onOpenAgent={openAgentPanel}
                row={agentPanelRow}
                siblings={agentPanelSiblings}
                width={diffPanelWidth}
              />
            </>
          ) : diffPanelOpen ? (
            <>
              <div className="sidebar-resizer" onMouseDown={onDiffResizeStart} />
              <DiffPanel
                onClose={() => setDiffPanelOpen(false)}
                version={
                  diffSummary
                    ? `${diffSummary.insertions}:${diffSummary.deletions}:${diffSummary.files.length}`
                    : ''
                }
                width={diffPanelWidth}
              />
            </>
          ) : null}
        </div>
      </div>

      {alert && <AlertPopup onClose={() => setAlert('')} text={alert} />}

      {settingsOpen && (
        <SettingsModal
          initialTab={settingsInitialTab}
          onClose={() => {
            setSettingsOpen(false);
            // 설정창에서 넣은 키는 바로 환경에 반영된다. 연결 안내를 거둘지 다시 확인한다
            void window.newbie.providerReady().then(setProviderReady);
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          confirmLabel={confirm.confirmLabel}
          message={confirm.message}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            confirm.onConfirm();
            setConfirm(null);
          }}
          tone={confirm.tone}
        />
      )}
    </div>
  );
}

const EMPTY_ROWS: TranscriptRow[] = [];

let fallbackRowId = 0;
function ensureRowId(row: TranscriptRow): TranscriptRow {
  if (row.id) return row;
  fallbackRowId += 1;
  return { ...row, id: `row-${fallbackRowId}` };
}

