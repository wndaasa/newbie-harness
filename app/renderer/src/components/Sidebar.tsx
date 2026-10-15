import React, { useEffect, useMemo, useState } from 'react';
import { IconCode, IconMessage, IconMore, IconSettings } from './Icon.tsx';
import { UpdateRow } from './UpdateRow.tsx';
import chatDark00Url from '../../../assets/Newbie_chat_00_dark.png';
import chatLight00Url from '../../../assets/Newbie_chat_00_light.png';
import chatDark01Url from '../../../assets/Newbie_chat_01_dark.png';
import chatLight01Url from '../../../assets/Newbie_chat_01_light.png';
import mascotDarkUrl from '../../../assets/Newbie_mascot_dark.png';
import mascotLightUrl from '../../../assets/Newbie_mascot_light.png';
import type { SessionSummary, TabMode, UpdateState } from '../types.ts';

/*
 * 상단 탭. 채팅은 파일·셸 도구 없이 대화만, 코딩은 지금까지의 전체 기능.
 * 세션 목록도 지금 탭의 대화만 보여준다 — 두 대화는 성격이 아예 달라서
 * 한 목록에 섞이면 무엇을 여는 건지 알 수 없다.
 */
const TABS: { id: TabMode; label: string }[] = [
  { id: 'chat', label: '채팅' },
  { id: 'agent', label: '코딩' },
];

// 세션 목록 보기 설정 (localStorage에 저장)
type SessionView = {
  /** 'all' 또는 필터할 projectPath */
  project: string;
  groupBy: 'date' | 'project';
  /** 마지막 채팅 시각(modified) 기준 정렬 방향 — 최신순/오래된순 */
  sortBy: 'recent' | 'oldest';
};

// 응답 중 마스코트: 입 모양만 다른 두 장을 번갈아 보여 말하는 것처럼 보이게 한다
const MASCOT_CHAT_FRAMES = {
  light: [chatLight00Url, chatLight01Url],
  dark: [chatDark00Url, chatDark01Url],
};
const MASCOT_FRAME_MS = 400;

const SESSION_VIEW_KEY = 'newbie.sessionView';
const DEFAULT_SESSION_VIEW: SessionView = { project: 'all', groupBy: 'date', sortBy: 'recent' };
// 화면 분할: 세션을 칸으로 끌어다 놓을 때 dataTransfer에 싣는 형식 (Pane과 동일)
const DRAG_MIME = 'application/x-newbie-session';

function loadSessionView(): SessionView {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_VIEW_KEY) ?? '');
    return {
      project: typeof stored.project === 'string' ? stored.project : 'all',
      groupBy: stored.groupBy === 'project' ? 'project' : 'date',
      sortBy: stored.sortBy === 'oldest' ? 'oldest' : 'recent',
    };
  } catch {
    return DEFAULT_SESSION_VIEW;
  }
}

// 접어 둔 그룹 ("묶음 기준:제목"). 앱을 다시 켜도 유지한다
const COLLAPSED_GROUPS_KEY = 'newbie.collapsedGroups';

function loadCollapsedGroups(): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter(key => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

function dateBucket(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  if (date >= startOfToday) return '오늘';
  if (date >= new Date(startOfToday.getTime() - dayMs)) return '어제';
  if (date >= new Date(startOfToday.getTime() - 7 * dayMs)) return '최근 7일';
  return '이전';
}

// 필터·정렬·그룹을 적용해 [그룹 제목, 세션들] 목록으로 변환
function buildGroups(
  sessions: SessionSummary[],
  view: SessionView,
): [string, SessionSummary[]][] {
  const filtered =
    view.project === 'all'
      ? sessions
      : sessions.filter(session => session.projectPath === view.project);
  // 최신순·오래된순 모두 마지막 채팅 시각(modified) 기준, 방향만 다름
  const sorted = [...filtered].sort((a, b) => {
    const diff = new Date(a.modified).getTime() - new Date(b.modified).getTime();
    return view.sortBy === 'oldest' ? diff : -diff;
  });

  const groups = new Map<string, SessionSummary[]>();
  for (const session of sorted) {
    const key =
      view.groupBy === 'project' ? session.projectName : dateBucket(session.modified);
    const bucket = groups.get(key) ?? [];
    bucket.push(session);
    groups.set(key, bucket);
  }
  return [...groups.entries()];
}

export function Sidebar({
  currentSessionId,
  onDeleteSession,
  onNewSession,
  onNewSessionIn,
  onRenameSession,
  onResumeSession,
  onSessionDragStart,
  onSessionDragEnd,
  onSetTabMode,
  onToggleSettings,
  onUpdateAction,
  sessions,
  tabMode,
  talking = false,
  update,
  width,
}: {
  currentSessionId: string;
  onDeleteSession: (sessionId: string) => void;
  onNewSession: () => void;
  /** 프로젝트 그룹의 +: 그 폴더에서 새 대화 */
  onNewSessionIn: (path: string) => void;
  onRenameSession: (sessionId: string, name: string) => void;
  onResumeSession: (sessionId: string) => void;
  /** 화면 분할: 세션 드래그 시작/끝 — App이 칸의 드롭존을 켜고 끈다 */
  onSessionDragStart?: () => void;
  onSessionDragEnd?: () => void;
  onSetTabMode: (mode: TabMode) => void;
  onToggleSettings: () => void;
  /** 업데이트 줄을 눌렀다 — App이 상태에 맞는 확인을 띄운다 */
  onUpdateAction?: () => void;
  sessions: SessionSummary[];
  tabMode: TabMode;
  /** 열린 칸 중 하나라도 에이전트가 돌고 있음 — 마스코트가 말하는 모습이 된다 */
  talking?: boolean;
  update?: UpdateState;
  width: number;
}) {
  // 컨텍스트 메뉴(⋮)가 열려 있는 세션과 표시 좌표.
  // 세션 목록이 스크롤 컨테이너라 fixed 좌표로 띄워 잘림을 방지함.
  const [menuFor, setMenuFor] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  // 인라인 이름 변경 중인 세션
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [view, setView] = useState<SessionView>(loadSessionView);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsedGroups);
  const [mascotFrame, setMascotFrame] = useState(0);

  // 응답 중에만 타이머를 돌린다. 움직임 줄이기 설정이면 첫 장에 멈춰 둔다
  useEffect(() => {
    setMascotFrame(0);
    if (!talking || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => setMascotFrame(frame => 1 - frame), MASCOT_FRAME_MS);
    return () => clearInterval(timer);
  }, [talking]);

  function toggleGroup(key: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  function updateView(patch: Partial<SessionView>) {
    setView(previous => {
      const next = { ...previous, ...patch };
      localStorage.setItem(SESSION_VIEW_KEY, JSON.stringify(next));
      return next;
    });
  }

  // 채팅 세션은 프로젝트에 매이지 않으므로 채팅 탭에서는 프로젝트 필터·그룹을
  // 무시한다. 보기 설정이 두 탭에서 공유되므로, 코딩 탭에서 걸어둔 프로젝트
  // 필터가 채팅 목록까지 거르는 일을 막는다.
  const effectiveView: SessionView = useMemo(
    () => (tabMode === 'chat' ? { ...view, groupBy: 'date', project: 'all' } : view),
    [tabMode, view],
  );
  // 사이드바는 대화가 흐르는 동안 자주 다시 그려지므로 목록이 같으면 정렬·그룹을
  // 다시 하지 않는다. 날짜 묶음(오늘·어제)은 자정을 넘기면 바뀌어야 해서 날짜도 본다
  const today = new Date().toDateString();
  const groups = useMemo(
    () => buildGroups(sessions, effectiveView),
    [sessions, effectiveView, today],
  );

  function commitRename() {
    if (!editing) return;
    const name = editing.draft.trim();
    if (name) onRenameSession(editing.id, name);
    setEditing(null);
  }

  function renderSessionRow(session: SessionSummary) {
    return (
      <div
        className={
          session.sessionId === currentSessionId
            ? 'session-row active'
            : 'session-row'
        }
        key={session.sessionId}
      >
        {editing?.id === session.sessionId ? (
              <input
                autoFocus
                className="session-rename-input"
                onBlur={() => setEditing(null)}
                onChange={event =>
                  setEditing(previous =>
                    previous ? { ...previous, draft: event.target.value } : previous,
                  )
                }
                onKeyDown={event => {
                  if (event.key === 'Enter') commitRename();
                  if (event.key === 'Escape') setEditing(null);
                }}
                value={editing.draft}
              />
            ) : (
              <button
                className="session-item"
                draggable
                onClick={() => onResumeSession(session.sessionId)}
                onDragEnd={() => onSessionDragEnd?.()}
                onDragStart={event => {
                  event.dataTransfer.setData(DRAG_MIME, session.sessionId);
                  event.dataTransfer.effectAllowed = 'move';
                  onSessionDragStart?.();
                }}
                type="button"
              >
                {session.name || session.firstPrompt || '(내용 없음)'}
              </button>
            )}
            <button
              aria-label="세션 메뉴"
              className="session-menu-button"
              onClick={event => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenuFor(previous =>
                  previous?.id === session.sessionId
                    ? null
                    : { id: session.sessionId, x: rect.right, y: rect.bottom + 2 },
                );
              }}
              type="button"
            >
              <IconMore size={15} />
            </button>
            {menuFor?.id === session.sessionId && (
              <>
                <div className="chip-menu-overlay" onClick={() => setMenuFor(null)} />
                <div
                  className="session-menu"
                  style={{ left: menuFor.x, top: menuFor.y }}
                >
                  <button
                    className="chip-menu-item"
                    onClick={() => {
                      setMenuFor(null);
                      setEditing({
                        id: session.sessionId,
                        draft: session.name || session.firstPrompt || '',
                      });
                    }}
                    type="button"
                  >
                    이름 변경
                  </button>
                  <button
                    className="chip-menu-item danger"
                    onClick={() => {
                      setMenuFor(null);
                      onDeleteSession(session.sessionId);
                    }}
                    type="button"
                  >
                    삭제
                  </button>
                </div>
              </>
            )}
      </div>
    );
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-tabs" role="tablist">
        {TABS.map(tab => (
          <button
            aria-selected={tabMode === tab.id}
            className={`sidebar-tab${tabMode === tab.id ? ' active' : ''}`}
            key={tab.id}
            onClick={() => onSetTabMode(tab.id)}
            role="tab"
            type="button"
          >
            {tab.id === 'chat' ? <IconMessage size={14} /> : <IconCode size={14} />}
            {tab.label}
          </button>
        ))}
      </div>

      <div className="sidebar-brand">
        <span aria-label="Newbie 마스코트" className="sidebar-mascot" role="img">
          {/* 테마별 두 장을 다 두고 CSS가 data-theme에 맞는 쪽만 보여준다 */}
          <img
            alt=""
            className={`sidebar-mascot-light${talking ? ' talking' : ''}`}
            src={talking ? MASCOT_CHAT_FRAMES.light[mascotFrame] : mascotLightUrl}
          />
          <img
            alt=""
            className={`sidebar-mascot-dark${talking ? ' talking' : ''}`}
            src={talking ? MASCOT_CHAT_FRAMES.dark[mascotFrame] : mascotDarkUrl}
          />
        </span>
      </div>

      <button className="new-chat" onClick={onNewSession} type="button">
        {/* 텍스트 + 글리프는 폰트 따라 세로 정렬이 어긋나 SVG 아이콘 사용 */}
        <svg className="new-chat-icon" fill="none" height="12" viewBox="0 0 16 16" width="12">
          <path
            d="M8 2.5v11M2.5 8h11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="2"
          />
        </svg>
        새 대화
      </button>

      {/* 제목 줄은 스크롤 컨테이너(.session-list) 밖에 둠 — 안에 있으면
          overflow-y가 절대 위치 하위 메뉴를 컨테이너 경계에서 잘라버림 */}
      <div className="session-list-head">
        <span className="session-list-title">대화</span>
        <SessionViewMenu
          onChange={updateView}
          sessions={sessions}
          showProject={tabMode !== 'chat'}
          view={view}
        />
      </div>

      <nav className="session-list">
        {sessions.length === 0 && (
          <div className="session-empty">저장된 대화가 없습니다</div>
        )}
        {sessions.length > 0 && groups.length === 0 && (
          <div className="session-empty">조건에 맞는 대화가 없습니다</div>
        )}
        {groups.map(([title, groupSessions]) => {
          // 날짜 묶음의 "오늘"과 같은 이름의 프로젝트가 서로의 접힘을 공유하지 않게 한다
          const key = `${effectiveView.groupBy}:${title}`;
          const open = !collapsed.has(key);
          // 프로젝트로 묶었을 때만 그룹이 폴더 하나에 대응한다. 그룹은 폴더 이름으로
          // 묶이므로 이름이 같은 다른 경로가 섞였으면 첫 세션의 폴더를 쓴다
          const folder =
            effectiveView.groupBy === 'project' ? groupSessions[0]?.projectPath : undefined;
          return (
            <React.Fragment key={title}>
              <div className="session-group-head">
                <button
                  aria-expanded={open}
                  className="session-group-title"
                  onClick={() => toggleGroup(key)}
                  title={title}
                  type="button"
                >
                  <span className="session-group-name">{title}</span>
                  <svg
                    aria-hidden="true"
                    className={`session-group-arrow${open ? ' open' : ''}`}
                    fill="none"
                    height="10"
                    viewBox="0 0 10 10"
                    width="10"
                  >
                    <path d="M2.5 3.75 5 6.25l2.5-2.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2" />
                  </svg>
                </button>
                {folder && (
                  <button
                    aria-label={`${title}에서 새 대화`}
                    className="session-group-add"
                    onClick={() => onNewSessionIn(folder)}
                    title={`${title}에서 새 대화`}
                    type="button"
                  >
                    <svg aria-hidden="true" fill="none" height="12" viewBox="0 0 12 12" width="12">
                      <path d="M6 2v8M2 6h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
                    </svg>
                  </button>
                )}
              </div>
              {open && groupSessions.map(renderSessionRow)}
            </React.Fragment>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        {update && <UpdateRow onClick={() => onUpdateAction?.()} state={update} />}
        <button className="settings-toggle" onClick={onToggleSettings} type="button">
          <IconSettings size={15} />
          설정
        </button>
      </div>
    </aside>
  );
}

// 정렬 버튼: 프로젝트 필터 / Group by / Sort by — 각 항목은 오른쪽 하위 메뉴로 선택.
// 채팅 탭(showProject=false)에서는 프로젝트가 의미 없으므로 Sort by만 남긴다
function SessionViewMenu({
  onChange,
  sessions,
  showProject,
  view,
}: {
  onChange: (patch: Partial<SessionView>) => void;
  sessions: SessionSummary[];
  showProject: boolean;
  view: SessionView;
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<'group' | 'project' | 'sort' | null>(null);

  // 중복 제거한 프로젝트 목록 (이름순)
  const projects = [...new Map(sessions.map(s => [s.projectPath, s.projectName])).entries()]
    .map(([path, name]) => ({ name, path }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const projectLabel =
    view.project === 'all'
      ? '전체'
      : projects.find(p => p.path === view.project)?.name ?? '전체';

  function toggle() {
    setSub(null);
    setOpen(previous => !previous);
  }

  function pick(patch: Partial<SessionView>) {
    onChange(patch);
    setSub(null);
    setOpen(false);
  }

  function renderItem(
    key: 'group' | 'project' | 'sort',
    label: string,
    value: string,
    options: { label: string; onPick: () => void; selected: boolean }[],
  ) {
    return (
      <span className="chip-submenu-anchor">
        <button
          className="chip-menu-item"
          onClick={() => setSub(previous => (previous === key ? null : key))}
          type="button"
        >
          <span className="chip-menu-item-label">{label}</span>
          {/* chip-menu-key는 모노 폰트라 한글 값이 어색함 — 값 표시는 별도 클래스.
              긴 프로젝트명이 줄바꿈되지 않도록 값 텍스트만 말줄임하고 화살표는 유지 */}
          <span className="chip-menu-value">
            <span className="chip-menu-value-name">{value}</span>
            <span className="chip-menu-value-arrow">▸</span>
          </span>
        </button>
        {sub === key && (
          <div className="chip-submenu right down">
            {options.map(option => (
              <button
                className="chip-menu-item"
                key={option.label}
                onClick={option.onPick}
                type="button"
              >
                <span className="chip-menu-ellipsis">{option.label}</span>
                <span className="chip-menu-key">
                  {option.selected && <span className="chip-menu-check">✓</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </span>
    );
  }

  return (
    <span className="chip-anchor">
      {open && <div className="chip-menu-overlay" onClick={() => setOpen(false)} />}
      <button
        aria-label="목록 보기 설정"
        className="session-view-button"
        onClick={toggle}
        title={showProject ? '정렬·그룹·프로젝트 필터' : '정렬'}
        type="button"
      >
        <SlidersIcon />
      </button>
      {open && (
        <div className="chip-menu down session-view-menu">
          {showProject && renderItem('project', '프로젝트', projectLabel, [
            { label: '전체', onPick: () => pick({ project: 'all' }), selected: view.project === 'all' },
            ...projects.map(project => ({
              label: project.name,
              onPick: () => pick({ project: project.path }),
              selected: view.project === project.path,
            })),
          ])}
          {showProject && renderItem('group', 'Group by', view.groupBy === 'date' ? '날짜' : '프로젝트', [
            { label: '날짜', onPick: () => pick({ groupBy: 'date' }), selected: view.groupBy === 'date' },
            { label: '프로젝트', onPick: () => pick({ groupBy: 'project' }), selected: view.groupBy === 'project' },
          ])}
          {renderItem('sort', 'Sort by', view.sortBy === 'recent' ? '최신순' : '오래된순', [
            { label: '최신순', onPick: () => pick({ sortBy: 'recent' }), selected: view.sortBy === 'recent' },
            { label: '오래된순', onPick: () => pick({ sortBy: 'oldest' }), selected: view.sortBy === 'oldest' },
          ])}
        </div>
      )}
    </span>
  );
}

function SlidersIcon() {
  return (
    <svg fill="none" height="13" viewBox="0 0 16 16" width="13">
      <path d="M2 5h12M2 11h12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <circle cx="6" cy="5" fill="var(--bg)" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="11" fill="var(--bg)" r="1.8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
