import {
  IconAlert,
  IconChevronDown,
  IconChevronRight,
  IconDot,
  IconImage,
} from './Icon.tsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentStatus, ApprovalRequest, TranscriptRow } from '../types.ts';
import { CopyButton } from './CopyButton.tsx';
import { ImageLightbox } from './ImageLightbox.tsx';
import { CodeBlock, highlightHtml, languageForPath, Markdown } from './Markdown.tsx';
import { isProseResult } from '../toolResultKind.ts';
import { formatRelativeTime } from '../relativeTime.ts';
import { formatTokens } from './StatusMenus.tsx';

// 연속된 tool 행을 하나의 그룹으로 묶음 (요약 줄 → 펼침 UI용)
type TranscriptItem =
  | { kind: 'row'; row: TranscriptRow }
  | { kind: 'tools'; id: string; rows: TranscriptRow[] };

/** 부모 행 id → 그 안에서 일어난 도구 행 (보조 에이전트의 자식 호출) */
export type ChildRows = Map<string, TranscriptRow[]>;

export function collectChildren(rows: TranscriptRow[]): ChildRows {
  const ids = new Set(rows.map(row => row.id));
  const children: ChildRows = new Map();
  for (const row of rows) {
    // 부모 행이 잘려 나간 자식(복원 상한 등)은 고아로 두지 않고 최상위에 그린다
    if (!row.parentId || !ids.has(row.parentId)) continue;
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  return children;
}

/** 보조 에이전트를 띄운 도구 행인가 */
export function isAgentRow(row: TranscriptRow): boolean {
  return row.role === 'tool' && row.name === 'spawn_agent';
}

/**
 * 같은 턴에 뜬 형제 보조 에이전트를 순서대로 모은다.
 *
 * 한 응답에서 spawn_agent를 여러 번 부르면 패널에는 그중 하나만 보인다. 몇 개
 * 중 몇 번째를 보고 있는지 알 수 없어, 둘을 맡긴 턴에서 하나만 돈 줄 알기
 * 쉽다. 직전 사용자 메시지 이후 구간에서 같은 부모로 뜬 에이전트만 형제로
 * 본다 — 앞 턴의 조사까지 함께 세면 이번 턴에 몇 개를 맡겼는지가 흐려진다.
 */
export function agentSiblings(rows: TranscriptRow[], row: TranscriptRow): TranscriptRow[] {
  const index = rows.findIndex(item => item.id === row.id);
  if (index === -1) return [row];

  let start = 0;
  for (let i = index; i >= 0; i -= 1) {
    if (rows[i].role === 'user') {
      start = i + 1;
      break;
    }
  }
  let end = rows.length;
  for (let i = index + 1; i < rows.length; i += 1) {
    if (rows[i].role === 'user') {
      end = i;
      break;
    }
  }

  return rows
    .slice(start, end)
    .filter(item => isAgentRow(item) && item.parentId === row.parentId);
}

/**
 * 도구 사이에 낀 "생각만 있는" 행인가.
 *
 * 한 라운드가 끝날 때마다 assistant 행이 새로 열리므로(controller의
 * ensureAssistantRow), 도구를 여러 번 부르는 턴은 생각-도구-생각-도구로
 * 계단이 쌓인다. 본문 없이 생각만 든 행이 도구 앞에 오면 그 도구 묶음의
 * 일부로 본다 — 실제로 그 도구를 부르려고 한 생각이다.
 *
 * 뒤에 도구가 오는지까지 보는 이유: 마지막 답변도 본문이 나오기 전 한때는
 * 생각만 든 행이라, 앞만 보고 묶으면 답변이 묶였다가 튀어나온다.
 */
function foldsIntoTools(
  row: TranscriptRow,
  rest: TranscriptRow[],
  nested: Set<string>,
): boolean {
  // trim()하는 이유: 모델이 도구를 부르기 전에 개행이나 공백 한 칸을 흘리는 일이
  // 잦다. 그러면 content가 "\n"이 되어 truthy가 되는데, 화면에는 아무것도 안
  // 보이므로 "본문 없는 생각 행"으로 보인다. 그걸 본문으로 치면 묶음이 매번
  // 끊겨 계단이 그대로 쌓인다
  if (row.role !== 'assistant' || row.content.trim() || !row.reasoning) return false;
  const next = rest.find(item => !nested.has(item.id));
  return next?.role === 'tool';
}

function groupRows(rows: TranscriptRow[], children: ChildRows): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const nested = new Set([...children.values()].flat().map(row => row.id));
  for (const [index, row] of rows.entries()) {
    if (nested.has(row.id)) continue;
    const last = items.at(-1);
    if (row.role === 'tool' || foldsIntoTools(row, rows.slice(index + 1), nested)) {
      if (last?.kind === 'tools') {
        last.rows.push(row);
      } else {
        items.push({ kind: 'tools', id: `group-${row.id}`, rows: [row] });
      }
    } else {
      items.push({ kind: 'row', row });
    }
  }
  return items;
}

export function Transcript({
  activeAgentId,
  approval,
  onOpenAgent,
  onOpenSettings,
  rows,
  status,
  turnTokens,
}: {
  /** 우측 패널에 열려 있는 보조 에이전트 행 id (해당 행 강조용) */
  activeAgentId: string | null;
  approval: ApprovalRequest | null;
  /** 보조 에이전트 행 클릭 → 우측 패널 열기 */
  onOpenAgent: (id: string) => void;
  /** 오류 행이 설정창을 여는 통로 */
  onOpenSettings: () => void;
  rows: TranscriptRow[];
  status: AgentStatus | null;
  /** 진행 중인 턴에서 생성한 출력 토큰 누계 (라운드마다 갱신, 턴이 끝나면 null) */
  turnTokens: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  function scrollToBottom() {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // 하단 고정은 사용자가 위로 스크롤할 때만 풀고, 맨 아래로 돌아오면 다시 붙임.
  // 스트리밍 재렌더링으로 인한 레이아웃 변화(스크롤 이벤트 없음)로는 풀리지 않음
  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (el.scrollTop < lastScrollTop.current && distance > 1) {
      stickToBottom.current = false;
    } else if (distance < 40) {
      stickToBottom.current = true;
    }
    lastScrollTop.current = el.scrollTop;
  }

  // 코드 블록 등 내부 스크롤 영역에서 휠을 올리면 transcript에 scroll 이벤트가
  // 오지 않으므로, 버블되는 wheel 이벤트로 고정을 풀어 답변 생성 중에도 읽을 수 있게 함
  function onWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (event.deltaY < 0) stickToBottom.current = false;
  }

  // 스트리밍·이미지 로드 등 React 렌더와 무관한 높이 변화에도 하단 고정을 유지.
  // 스크롤 상자 자체도 본다 — 입력창이 내용에 맞춰 커지면 상자가 줄어드는데,
  // 안쪽 내용 크기는 그대로라 그것만 보면 마지막 줄이 입력창 뒤로 숨는다
  useEffect(() => {
    const el = containerRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom();
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // 사용자 메시지가 새로 붙으면 위로 올려 읽던 중이어도 맨 아래로 다시 붙인다. 보낸 말과
  // 그 답을 보려는 것인데, 고정이 풀린 채라 직접 내려야 했다. 처음 그릴 때(undefined)는
  // 새로 보낸 것이 아니라 건너뛴다
  const lastUserRowId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let lastUser: string | null = null;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].role === 'user') {
        lastUser = rows[index].id;
        break;
      }
    }
    if (lastUserRowId.current !== undefined && lastUser !== null && lastUser !== lastUserRowId.current) {
      stickToBottom.current = true;
    }
    lastUserRowId.current = lastUser;
    if (stickToBottom.current) scrollToBottom();
  }, [rows, status, approval]);

  function scrollToRow(id: string) {
    // 사용자가 과거 메시지로 이동한 것이므로 하단 고정을 풀어줌
    stickToBottom.current = false;
    containerRef.current
      ?.querySelector(`[data-row-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const userRows = rows.filter(row => row.role === 'user');
  const children = useMemo(() => collectChildren(rows), [rows]);
  // 스트리밍 중에는 상태 줄만 바뀌는 렌더도 잦다. 행이 그대로면 묶음도 그대로 써서
  // 도구 묶음(memo)이 같은 배열을 받게 한다
  const items = useMemo(() => groupRows(rows, children), [rows, children]);
  // 이 세션에서 돈 보조 에이전트 — 우측 상단 레일에서 바로 패널을 열 수 있게
  const agentRows = rows.filter(isAgentRow);

  return (
    <>
      <div className="transcript" onScroll={onScroll} onWheel={onWheel} ref={containerRef}>
        <div className="transcript-inner" ref={innerRef}>
          {items.map((item, index) =>
            item.kind === 'tools' ? (
              <ToolGroup
                activeAgentId={activeAgentId}
                childRows={children}
                key={item.id}
                onOpenAgent={onOpenAgent}
                onZoomImage={setZoomImage}
                rows={item.rows}
              />
            ) : (
              <Row
                key={item.row.id}
                // 턴이 진행 중이고 맨 마지막 행이면 아직 흘러들어오는 중이다
                isLast={index === items.length - 1}
                live={status !== null && index === items.length - 1}
                onOpenSettings={onOpenSettings}
                onZoomImage={setZoomImage}
                row={item.row}
              />
            ),
          )}
          {zoomImage && <ImageLightbox onClose={() => setZoomImage(null)} src={zoomImage} />}
          {status && !approval && <StatusLine status={status} turnTokens={turnTokens} />}
          {approval && (
            <div className="approval-line">
              <div>! 실행 승인 대기 — {approval.label}</div>
              {approval.reason && (
                <div className="approval-reason">{approval.reason}</div>
              )}
              {approval.detail && (
                <pre className="approval-detail">{approval.detail}</pre>
              )}
            </div>
          )}
        </div>
      </div>
      {userRows.length > 0 && <OutlineRail onSelect={scrollToRow} userRows={userRows} />}
      {agentRows.length > 0 && (
        <AgentRail
          activeAgentId={activeAgentId}
          agentRows={agentRows}
          onOpenAgent={onOpenAgent}
        />
      )}
    </>
  );
}

// ── 상대 시각 ("지금", "3분 전") ──
//
// 30초마다 다시 그린다. 매 렌더마다 Date.now()를 읽으면 스트리밍 중 수백 번
// 바뀌어 깜빡이므로, 한 박자로 움직이는 시계를 둔다. 행마다 타이머를 만들지 않게
// 화면의 모든 RelativeTime이 타이머 하나를 나눠 쓴다
const CLOCK_TICK_MS = 30_000;
const clockListeners = new Set<(now: number) => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    clockListeners.add(setNow);
    clockTimer ??= setInterval(() => {
      const tick = Date.now();
      for (const listener of clockListeners) listener(tick);
    }, CLOCK_TICK_MS);
    return () => {
      clockListeners.delete(setNow);
      if (clockListeners.size === 0 && clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
    };
  }, []);
  return now;
}

function RelativeTime({ at }: { at: string }) {
  const now = useClock();
  const absolute = new Date(at);
  return (
    <span className="row-time" title={Number.isNaN(absolute.getTime()) ? undefined : absolute.toLocaleString()}>
      {formatRelativeTime(at, now)}
    </span>
  );
}

// ── 추론 요약 블록 (어시스턴트 본문 위) ──
//
// 생각하는 동안(본문이 아직 없음)에는 펼쳐서 요약이 흘러드는 것을 보여주고,
// 본문이 시작되거나 턴이 끝나면 "생각" 한 줄로 접는다. 사용자가 직접 여닫으면
// 그 선택을 따른다. 내용은 제공자가 보낸 추론 요약이나 원문이라 영어로 오는 경우가 많다.
function ReasoningBlock({
  inGroup,
  text,
  thinking,
}: {
  /** 도구 묶음 안에 들어간 행인지. 도구 행과 같은 자리·같은 높이로 그린다 */
  inGroup?: boolean;
  text: string;
  thinking: boolean;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? thinking;

  return (
    <div className={inGroup ? 'reasoning in-group' : 'reasoning'}>
      <button
        className="reasoning-head"
        onClick={() => setManual(!open)}
        type="button"
      >
        {thinking && <span className="reasoning-pulse"><IconDot size={7} /></span>}
        <span className="reasoning-label">{thinking ? '생각 중' : '생각'}</span>
        {/* 도구 행의 대상 칸과 같은 자리를 차지해 화살표가 같은 x에 오게 한다 */}
        {inGroup && <span className="tool-item-target" />}
        <span className="tool-summary-chevron">
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </span>
      </button>
      {open && (
        <div className="reasoning-body">
          <Markdown content={text} />
        </div>
      )}
    </div>
  );
}

// ── 대화 미니맵: 우측 가운데 눈금 → 호버하면 내 프롬프트 목록 → 클릭하면 해당 위치로 ──

const MAX_OUTLINE_TICKS = 10;

function OutlineRail({
  onSelect,
  userRows,
}: {
  onSelect: (id: string) => void;
  userRows: TranscriptRow[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="outline-rail"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {open ? (
        <div className="outline-panel">
          {userRows.map(row => (
            <button
              className="outline-item"
              key={row.id}
              onClick={() => onSelect(row.id)}
              type="button"
            >
              {row.content || '(이미지)'}
            </button>
          ))}
        </div>
      ) : (
        <div className="outline-ticks">
          {userRows.slice(-MAX_OUTLINE_TICKS).map(row => (
            <span className="outline-tick" key={row.id} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 에이전트 레일: 우측 상단 점 3개 → 호버하면 세션 작업 목록 → 클릭하면 우측 패널 ──
//
// 보조 에이전트 행은 대화가 길어지면 스크롤 위로 밀려나 찾기 어렵다. 미니맵과
// 같은 방식의 고정 진입점을 둬서 어디서든 패널을 열 수 있게 한다.
function AgentRail({
  activeAgentId,
  agentRows,
  onOpenAgent,
}: {
  activeAgentId: string | null;
  agentRows: TranscriptRow[];
  onOpenAgent: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="agent-rail"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {open ? (
        <div className="outline-panel">
          <div className="agent-rail-title">세션 작업</div>
          {agentRows.map(row => (
            <button
              className={`agent-rail-item${row.id === activeAgentId ? ' active' : ''}`}
              key={row.id}
              onClick={() => onOpenAgent(row.id)}
              type="button"
            >
              {row.toolStatus === 'running' && (
                <span className="tool-summary-spinner"><IconDot size={7} /></span>
              )}
              <span className="tool-item-kind">{row.target || '탐색'}</span>
              <span className="agent-rail-label">{row.content}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="agent-rail-dots">
          <IconDot size={4} />
          <IconDot size={4} />
          <IconDot size={4} />
        </div>
      )}
    </div>
  );
}

/**
 * 다시 시도가 의미 있는 오류.
 *
 * 인증·권한·모델 없음은 설정을 바꾸지 않는 한 같은 이유로 또 실패하고,
 * 컨텍스트 초과도 마찬가지다. 그런 자리에 버튼을 두면 사용자를 붙잡아 두기만 한다.
 */
const RETRYABLE_KINDS = new Set(['rate-limit', 'network', 'server', 'unknown']);

/**
 * 원인별 조치. 오류에 "설정에서 키를 넣으세요"라고 적어 두는 것과 그 자리에
 * 설정을 여는 버튼을 두는 것은 체감이 전혀 다르다.
 */
const ERROR_ACTIONS: Record<string, { kind: 'settings' | 'new-session'; label: string }> = {
  auth: { kind: 'settings', label: '설정 열기' },
  permission: { kind: 'settings', label: '설정 열기' },
  quota: { kind: 'settings', label: '설정 열기' },
  'model-not-found': { kind: 'settings', label: '모델 바꾸기' },
  'context-length': { kind: 'new-session', label: '새 대화' },
};

/**
 * 대화 안의 오류 한 줄.
 *
 * 빨간 글씨 한 줄이던 자리다. 제목은 무엇이 잘못됐는지 사람 말로 적고,
 * 제공자가 실제로 보낸 문장은 접어 둔다 — 둘 중 하나만 있으면 안 된다.
 * 원문만 있으면 뭘 해야 할지 알 수 없고, 제목만 있으면 원인을 좁힐 수 없다.
 *
 * 카드는 중립색이다. 빨강은 아이콘과 왼쪽 선까지만 쓴다 — 로컬 모델이나
 * 한도 초과처럼 흔한 실패까지 매번 빨간 상자로 알리면 그냥 소음이 된다.
 */
function ErrorRow({
  isLast,
  onOpenSettings,
  row,
}: {
  /** 대화의 마지막 행인가. 지나간 오류의 버튼은 눌러 봐야 엉뚱한 턴을 되살린다 */
  isLast?: boolean;
  onOpenSettings?: () => void;
  row: TranscriptRow;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const detail = row.errorDetail ?? '';
  const action = ERROR_ACTIONS[row.errorKind ?? ''];

  return (
    <div className="row row-error" role="alert">
      <div className="row-error-head">
        <IconAlert size={15} />
        <span className="row-error-title">{row.content}</span>
      </div>

      {detail && (
        <>
          <button
            className="row-error-toggle"
            onClick={() => setOpen(value => !value)}
            type="button"
          >
            {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
            자세히
          </button>
          {open && <pre className="row-error-detail">{detail}</pre>}
        </>
      )}

      <div className="row-error-actions">
        {isLast && RETRYABLE_KINDS.has(row.errorKind ?? '') && (
          <button
            className="row-error-action primary"
            onClick={() => window.newbie.retryLastTurn()}
            type="button"
          >
            다시 시도
          </button>
        )}
        {action && (
          <button
            className="row-error-action primary"
            onClick={() => {
              if (action.kind === 'settings') onOpenSettings?.();
              else window.newbie.newSession();
            }}
            type="button"
          >
            {action.label}
          </button>
        )}
        {detail && (
          <button
            className="row-error-action"
            onClick={() => {
              void navigator.clipboard.writeText(detail).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            type="button"
          >
            {copied ? '복사됨' : '오류 복사'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 이력 압축 줄.
 *
 * 접는 동안은 "압축 중..."을 입력창의 자리표시자처럼 흐리게 띄우고, 끝나면 같은
 * 줄이 "대화 압축 완료 · 수동 · 945k 토큰 절약"과 물결 구분선으로 바뀐다. 구분선
 * 위가 접힌 부분이다. 줄을 누르면 모델이 받는 압축문 전체(요약과 요청 원문 목록)를
 * 펼쳐 본다 — 요약만 보여 주면 요청이 빠진 것처럼 보였다
 */
function CompactRow({ row }: { row: TranscriptRow }) {
  const [open, setOpen] = useState(false);
  const compact = row.compact;
  if (!compact) return null;
  if (compact.state === 'running') {
    return (
      <div className="row row-compact running" role="status">
        압축 중...
      </div>
    );
  }

  const trigger = compact.trigger === 'manual' ? '수동' : '자동';
  const summary = compact.state === 'done' ? (compact.brief ?? '').trim() : '';
  const title =
    compact.state === 'done'
      ? [
          '대화 압축 완료',
          trigger,
          ...(compact.freedTokens !== undefined
            ? [`${formatTokens(compact.freedTokens)} 토큰 절약`]
            : []),
        ].join(' · ')
      : compact.state === 'skipped'
        ? '압축할 만큼 쌓인 대화가 없습니다'
        : `압축하지 못했습니다${compact.error ? ` · ${compact.error}` : ''}`;

  return (
    <div className="row row-compact">
      <button
        aria-expanded={summary ? open : undefined}
        className="row-compact-head"
        disabled={!summary}
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        <span>{title}</span>
        {summary && (open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />)}
      </button>
      {open && summary && <pre className="row-compact-summary">{summary}</pre>}
      {compact.state === 'done' && (
        <div aria-hidden="true" className="row-compact-divider">
          <span className="row-compact-wave" />
          <span className="row-compact-label">압축됨</span>
          <span className="row-compact-wave" />
        </div>
      )}
    </div>
  );
}

/** 멈춘 이유 아래에 붙는, 다음에 할 수 있는 일 */
const STOP_HINTS: Record<string, string> = {
  classifier_down: '분류기 모델 상태를 확인하거나 권한 모드를 바꾼 뒤 이어서 하세요.',
  context: '이어서 하면 지난 부분을 접고 계속합니다. 다시 멈추면 한 번에 보낸 글을 나눠서 보내 주세요.',
  denied:
    '허용해도 되는 명령이면 허용하고 이어서 하세요. 허용은 정확히 같은 명령에만, 앱을 다시 켤 때까지 적용됩니다.',
  no_progress: '방법을 알려 주거나, 그대로 이어서 하게 할 수 있습니다.',
};

/**
 * 턴이 답 없이 멈춘 이유.
 *
 * 문장은 메인 프로세스가 적어 보낸 것(content)을 그대로 쓴다. 버튼은 이 행이 대화의
 * 마지막일 때만 붙인다 — 지나간 안내의 버튼은 눌러 봐야 엉뚱한 턴을 잇는다
 */
function StopRow({ isLast, row }: { isLast?: boolean; row: TranscriptRow }) {
  const blocked = row.stop?.cause === 'denied' ? (row.stop.blocked ?? []) : [];
  const hint = STOP_HINTS[row.stop?.cause ?? ''];
  return (
    <div className="row row-error row-stop" role="status">
      <div className="row-error-head">
        <IconAlert size={15} />
        <span className="row-error-title">{row.content}</span>
      </div>
      {hint && <div className="row-stop-hint">{hint}</div>}
      {blocked.length > 0 && (
        <ul className="row-stop-blocked">
          {blocked.map(call => (
            <li key={call.command}>
              <code>{call.command}</code>
              <span>{call.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {isLast && (
        <div className="row-error-actions">
          {blocked.length > 0 && (
            <button
              className="row-error-action primary"
              onClick={() => window.newbie.continueAfterStop(undefined, true)}
              type="button"
            >
              허용하고 이어서
            </button>
          )}
          <button
            className={`row-error-action${blocked.length > 0 ? '' : ' primary'}`}
            onClick={() => window.newbie.continueAfterStop()}
            type="button"
          >
            이어서 하기
          </button>
        </div>
      )}
    </div>
  );
}

/*
 * 행은 memo다. 대화에 상한이 없어 수천 행이 쌓이는데, 스트리밍은 청크마다 마지막
 * 행 하나만 바꾼다. 나머지 행의 row 객체와 콜백은 그대로이므로 여기서 걸러야
 * 청크마다 전체를 다시 그리지 않는다
 */
const Row = React.memo(RowView);

function RowView({
  isLast,
  live,
  onOpenSettings,
  onZoomImage,
  row,
}: {
  /** 턴이 진행 중인 맨 마지막 행 (스트리밍 중) */
  live?: boolean;
  /** 대화의 마지막 행인가 (오류 행의 '다시 시도' 노출 판단) */
  isLast?: boolean;
  /** 오류 행의 '설정 열기' 버튼. 최상위 행에만 내려온다 */
  onOpenSettings?: () => void;
  onZoomImage: (src: string) => void;
  row: TranscriptRow;
}) {
  switch (row.role) {
    case 'user':
      return (
        <div className="row row-user" data-row-id={row.id}>
          {row.images && row.images.length > 0 && (
            <div className="row-user-images">
              {row.images.map((image, index) => (
                <img
                  alt={`첨부 이미지 ${index + 1}`}
                  key={index}
                  onClick={() => onZoomImage(image)}
                  src={image}
                />
              ))}
            </div>
          )}
          {row.content && <div className="row-user-bubble">{row.content}</div>}
          {/* 말풍선 아래: 복사 + 모델이 읽은 시각. 안 읽었으면 "안읽음" */}
          <div className="row-meta right">
            {row.content && (
              <CopyButton className="row-copy" label="메시지 복사" text={row.content} />
            )}
            {row.readAt ? (
              <RelativeTime at={row.readAt} />
            ) : (
              <>
                <span className="row-time unread">안읽음</span>
                {/* 작업 중에 보낸 메시지는 지금 라운드가 끝나야 읽힌다. 기다리지 않고
                    진행 중인 생성이나 명령을 끊어 모델이 바로 읽게 한다 */}
                <button
                  className="row-send-now"
                  onClick={() => window.newbie.interjectNow(row.id)}
                  title="진행 중인 작업을 끊고 이 메시지를 바로 읽게 합니다"
                  type="button"
                >
                  지금 보내기
                </button>
              </>
            )}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="row row-assistant">
          <div className="row-assistant-body">
            {row.reasoning && (
              <ReasoningBlock thinking={Boolean(live) && !row.content} text={row.reasoning} />
            )}
            {row.content ? <Markdown content={row.content} /> : null}
            {/* 답변 아래 한 줄: 복사 + 완성 시각. 본문 위에 띄우면 글자를 가리고,
                스트리밍 중엔 자리가 계속 바뀐다. 시각은 완성된 뒤에만 */}
            {row.content && (
              <div className="row-meta">
                <CopyButton className="row-copy" label="답변 복사 (마크다운)" text={row.content} />
                {row.at && <RelativeTime at={row.at} />}
              </div>
            )}
          </div>
        </div>
      );
    case 'system':
      return <div className="row row-system">{row.content}</div>;
    case 'compact':
      return <CompactRow row={row} />;
    case 'stop':
      return <StopRow isLast={isLast} row={row} />;
    case 'error':
      return <ErrorRow isLast={isLast} onOpenSettings={onOpenSettings} row={row} />;
    default:
      return <div className="row row-system">{row.content}</div>;
  }
}

// ── 도구 호출 그룹: "파일 읽기 2개, 파일 검색 ›" 요약 → 펼침 → 항목별 상세 ──

const ToolGroup = React.memo(function ToolGroup({
  activeAgentId,
  childRows,
  onOpenAgent,
  onZoomImage,
  rows,
}: {
  activeAgentId: string | null;
  childRows: ChildRows;
  onOpenAgent: (id: string) => void;
  onZoomImage: (src: string) => void;
  rows: TranscriptRow[];
}) {
  const [expanded, setExpanded] = useState(false);
  // 생각 행이 섞여 들어오므로 요약 줄과 상태 판정은 도구 행만 본다
  const toolRows = rows.filter(row => row.role === 'tool');
  const running = rows.some(row => row.toolStatus === 'running');
  const failed = rows.some(row => row.toolStatus === 'error');
  const blocked = rows.some(row => row.toolStatus === 'blocked');
  const hasImages = rows.some(row => (row.images?.length ?? 0) > 0);

  // 도구가 화면을 찍어 왔으면 접힌 채로 두지 않는다. 결과가 그림인데 두 번
  // 눌러야 보이면 사용자는 모델이 무엇을 보고 판단했는지 모른 채 지나간다.
  // 한 번만 펼치고, 사용자가 다시 접으면 그대로 둔다
  useEffect(() => {
    if (hasImages) setExpanded(true);
  }, [hasImages]);

  // 막힌 호출도 접힌 채로 두지 않는다. 사유를 보려고 두 번 눌러야 하면, 정작
  // 판단이 필요한 자리에서 사용자는 무엇이 왜 막혔는지 모른 채 지나간다
  useEffect(() => {
    if (blocked) setExpanded(true);
  }, [blocked]);

  return (
    <div className="tool-group">
      <button
        className="tool-summary"
        onClick={() => setExpanded(previous => !previous)}
        type="button"
      >
        {running && <span className="tool-summary-spinner"><IconDot size={7} /></span>}
        <span className={failed ? 'tool-summary-text failed' : 'tool-summary-text'}>
          {summarizeTools(toolRows)}
        </span>
        {blocked && <span className="tool-summary-blocked">승인 필요로 차단됨</span>}
        <span className="tool-summary-chevron">{expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}</span>
      </button>
      {expanded && (
        <div className="tool-items">
          {/* 순서는 실제로 일어난 그대로 둔다 — 생각을 위로 몰면 어느 도구
              앞의 생각이었는지 알 수 없다 */}
          {rows.map(row =>
            row.role === 'tool' ? (
              <ToolItem
                activeAgentId={activeAgentId}
                childRows={childRows}
                key={row.id}
                onOpenAgent={onOpenAgent}
                onZoomImage={onZoomImage}
                row={row}
              />
            ) : (
              <ReasoningBlock inGroup key={row.id} text={row.reasoning ?? ''} thinking={false} />
            ),
          )}
        </div>
      )}
    </div>
  );
});

function summarizeTools(rows: TranscriptRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.content, (counts.get(row.content) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => (count > 1 ? `${label} ${count}개` : label))
    .join(', ');
}

export const ToolItem = React.memo(function ToolItem({
  activeAgentId,
  childRows,
  onOpenAgent,
  onZoomImage,
  row,
}: {
  activeAgentId: string | null;
  childRows: ChildRows;
  onOpenAgent: (id: string) => void;
  onZoomImage: (src: string) => void;
  row: TranscriptRow;
}) {
  const images = row.images ?? [];
  // 이미지는 다른 상세와 마찬가지로 펼쳤을 때만 보인다. 처음에는 접혀 있어도
  // 보이게 했는데, 스크린샷이 커서 도구 목록을 훑을 때 화면을 다 잡아먹었다.
  // 대신 접힌 상태에서도 결과에 그림이 있다는 표시는 남긴다
  const [open, setOpen] = useState(false);
  // 줄 비교(LCS)는 줄 수의 곱만큼 든다. 행이 그대로면 다시 계산하지 않는다
  const diff = useMemo(
    () => (row.name === 'edit_file' ? buildLineDiff(row.input) : null),
    [row.name, row.input],
  );
  // 보조 에이전트는 인라인으로 펼치지 않는다. 자식 호출·보고까지 트랜스크립트에
  // 중첩해 그리면 대화가 묻혀서, 클릭하면 우측 패널(AgentPanel)에 연다
  const agent = row.name === 'spawn_agent';
  const children = childRows.get(row.id) ?? [];
  const active = agent && row.id === activeAgentId;

  return (
    <div
      className={`tool-item tool-${row.toolStatus ?? 'done'}${agent ? ' tool-item-agent' : ''}${active ? ' active' : ''}`}
    >
      <button
        className="tool-item-head"
        onClick={() => (agent ? onOpenAgent(row.id) : setOpen(previous => !previous))}
        type="button"
      >
        {agent && <span className="tool-item-kind">{row.target || '탐색'}</span>}
        <span className="tool-item-label">{row.content}</span>
        {diff && <DiffSummary added={diff.added} removed={diff.removed} />}
        {agent ? (
          // 보조 에이전트는 대상 대신 안에서 돈 도구 수를 보여준다 — 접힌 채로도
          // 지금 얼마나 일하고 있는지 보인다
          <span className="tool-item-target">
            {children.length > 0 ? `도구 ${children.length}회` : ''}
          </span>
        ) : (
          row.target && <span className="tool-item-target">{row.target}</span>
        )}
        {images.length > 0 && !open && (
          <span className="tool-item-imagecount" title="화면 캡처 있음">
            <IconImage size={13} />
            {images.length > 1 && images.length}
          </span>
        )}
        <span className="tool-summary-chevron">
          {open && !agent ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </span>
      </button>
      {/* 자동 모드가 막은 명령은 그 자리에서 허용할 수 있다. 접힌 채로도 보여야 한다 —
          대화로 "해"라고 해도 분류기는 차단 목록을 풀지 않아, 사용자가 할 일은 이것이다 */}
      {row.allowable && (
        <div className="tool-item-allow">
          {row.allowed ? (
            <span className="tool-item-allow-hint">허용했습니다. 같은 명령을 다시 실행하게 했습니다.</span>
          ) : (
            <>
              <button
                className="tool-item-allow-button"
                onClick={() => window.newbie.allowBlockedCall(row.id)}
                type="button"
              >
                이 명령 허용
              </button>
              <span className="tool-item-allow-hint">정확히 같은 명령만, 앱을 다시 켤 때까지 허용합니다</span>
            </>
          )}
        </div>
      )}
      {open && !agent && (
        <div className="tool-item-detail">
          {images.length > 0 && (
            <div className="tool-item-images">
              {images.map((image, index) => (
                <img
                  alt={`도구 결과 이미지 ${index + 1}`}
                  key={index}
                  onClick={() => onZoomImage(image)}
                  src={image}
                />
              ))}
            </div>
          )}
          <ToolDetail row={row} />
        </div>
      )}
    </div>
  );
});

// ── 도구별 상세 표시: 명령은 "$ ..." 프롬프트, 파일은 확장자별 하이라이트 ──

function ToolDetail({ row }: { row: TranscriptRow }) {
  const input = row.input ?? {};
  const editDiff = useMemo(
    () => (row.name === 'edit_file' ? buildLineDiff(row.input) : null),
    [row.name, row.input],
  );
  const result =
    row.result ?? (row.toolStatus === 'running' ? '실행 중...' : '(결과 없음)');
  const done = row.result != null;

  switch (row.name) {
    case 'run_command':
    case 'start_process':
    case 'read_process':
    case 'stop_process':
    case 'run_git':
      return <CommandBlock row={row} />;
    case 'list_files':
      return <CodeBlock code={done ? formatListing(result) : result} />;
    case 'read_file':
      return (
        <CodeBlock
          code={done ? stripReadHeader(result) : result}
          language={languageForPath(String(input.path ?? ''))}
        />
      );
    case 'edit_file':
      return (
        <>
          {editDiff && <DiffView diff={editDiff} path={String(input.path ?? '')} />}
          <CodeBlock code={result} />
        </>
      );
    default:
      return <GenericDetail row={row} />;
  }
}

/** 인자 이름을 사람 말로. 없는 키는 그대로 보여준다 */
const PARAM_LABELS: Record<string, string> = {
  args: '인자',
  base: '기준',
  branch: '브랜치',
  glob: '파일 패턴',
  height: '높이',
  id: 'id',
  name: '이름',
  path: '경로',
  query: '검색어',
  url: '주소',
  width: '너비',
};

/*
 * 명령 도구 외의 상세 — 검색·웹·캡처·MCP 등. 명령 블록과 같은 상자에 머리에는
 * 인자를 "이름 값" 칩으로, 몸통에는 결과를 담는다. 예전에는 인자 값만 줄줄이
 * 찍혀서 "TODO|FIXME" 아래 "*.{ts,tsx}" 아래 "."처럼 무엇이 무엇인지 알 수 없었다.
 *
 * 결과가 안내 문장이면 본문 글꼴로, 코드·출력물이면 고정폭으로 그린다 — 고정폭
 * 글꼴엔 한글이 없어 문장을 고정폭으로 두면 한 줄 안에서 글꼴이 갈린다.
 */
function GenericDetail({ row }: { row: TranscriptRow }) {
  const input = row.input ?? {};
  const params = Object.entries(input).filter(
    ([key, value]) => key !== 'description' && String(value ?? '').trim(),
  );
  const running = row.toolStatus === 'running';
  const failed = row.toolStatus === 'error' || row.toolStatus === 'blocked';
  const result = row.result ?? '';

  return (
    <div className="term">
      {params.length > 0 && (
        <div className="term-head term-params">
          {params.map(([key, value]) => (
            <span className="term-param" key={key} title={key}>
              <span className="term-param-key">{PARAM_LABELS[key] ?? key}</span>
              <span className="term-param-value">{String(value)}</span>
            </span>
          ))}
        </div>
      )}
      {running ? (
        <div className="term-out term-running">실행 중...</div>
      ) : !result.trim() ? (
        <div className="term-out term-empty">결과 없음</div>
      ) : failed ? (
        <pre className="term-out stderr">{result}</pre>
      ) : isProseResult(result) ? (
        <div className="term-out term-prose">{result}</div>
      ) : (
        <pre className="term-out">{result}</pre>
      )}
    </div>
  );
}

type DiffLine = {
  kind: 'add' | 'context' | 'remove';
  newNumber?: number;
  oldNumber?: number;
  text: string;
};

type LineDiff = {
  added: number;
  lines: DiffLine[];
  removed: number;
};

function DiffSummary({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="diff-summary">
      <span className="diff-added">+{added}</span>
      <span className="diff-removed">-{removed}</span>
    </span>
  );
}

function DiffView({ diff, path }: { diff: LineDiff; path: string }) {
  return (
    <div className="diff-view">
      {path && <div className="diff-path">{path}</div>}
      <div className="diff-lines">
        {diff.lines.map((line, index) => (
          <div className={`diff-line diff-${line.kind}`} key={index}>
            <span className="diff-line-no">{line.oldNumber ?? ''}</span>
            <span className="diff-line-no">{line.newNumber ?? ''}</span>
            <span className="diff-marker">
              {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
            </span>
            <span className="diff-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildLineDiff(input: Record<string, string> | undefined): LineDiff | null {
  const oldText = input?.old_string;
  const newText = input?.new_string;
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null;

  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  const table = buildLcsTable(oldLines, newLines);
  const lines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldNumber = 1;
  let newNumber = 1;
  let added = 0;
  let removed = 0;

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLine === newLine) {
      lines.push({ kind: 'context', oldNumber, newNumber, text: oldLine });
      oldIndex += 1;
      newIndex += 1;
      oldNumber += 1;
      newNumber += 1;
    } else if (
      newIndex < newLines.length &&
      (oldIndex === oldLines.length || table[oldIndex][newIndex + 1] >= table[oldIndex + 1][newIndex])
    ) {
      lines.push({ kind: 'add', newNumber, text: newLine });
      newIndex += 1;
      newNumber += 1;
      added += 1;
    } else if (oldIndex < oldLines.length) {
      lines.push({ kind: 'remove', oldNumber, text: oldLine });
      oldIndex += 1;
      oldNumber += 1;
      removed += 1;
    }
  }

  return { added, lines, removed };
}

function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const table = Array.from({ length: oldLines.length + 1 }, () =>
    Array.from({ length: newLines.length + 1 }, () => 0),
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }

  return table;
}

function splitDiffLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '').split('\n');
}

// ── 명령 도구 상세: 터미널 블록 ("$ 명령" 머리 + 출력 + 종료 코드 배지) ──
//
// 예전에는 "$ 명령" 한 줄 아래 결과 텍스트를 통째로 찍어서, 종료 코드·stdout
// 구분선·안내 문장이 출력과 섞여 보였다. 도구가 돌려주는 텍스트(모델이 읽는
// 것)는 그대로 두고, 화면에서만 머리·출력·상태로 갈라 그린다.

type CommandView = {
  command: string;
  /** 머리 오른쪽 배지. 정상 종료는 배지 없이 조용히 */
  badge?: { text: string; tone: 'error' | 'info' };
  /** 출력이 없을 때 보여줄 문구 */
  emptyText: string;
  stderr: string;
  stdout: string;
};

const EXIT_LINE = /^종료 코드: (-?\d+)$/;
const TIMEOUT_LINE = /^시간 초과\((\d+)초\)로 중단됨 \(종료 코드: (-?\d+)\)$/;

function parseCommandView(row: TranscriptRow): CommandView {
  const input = row.input ?? {};
  const result = row.result ?? '';
  const failed = row.toolStatus === 'error' || row.toolStatus === 'blocked';
  const base: CommandView = { command: '', emptyText: '출력 없음', stderr: '', stdout: '' };

  switch (row.name) {
    case 'run_command': {
      const view = { ...base, command: String(input.command ?? '').trim() };
      if (failed) return { ...view, stderr: result };
      const [head = '', ...rest] = result.split('\n');
      const exit = EXIT_LINE.exec(head);
      const timeout = TIMEOUT_LINE.exec(head);
      if (!exit && !timeout) return { ...view, stdout: result };
      const code = Number(exit?.[1] ?? timeout?.[2]);
      if (timeout) view.badge = { text: `시간 초과 · 종료 코드 ${code}`, tone: 'error' };
      else if (code !== 0) view.badge = { text: `종료 코드 ${code}`, tone: 'error' };
      const sections = splitSections(rest.join('\n'), ['--- stdout ---', '--- stderr ---']);
      view.stdout = (sections['--- stdout ---'] ?? sections.$head ?? '').replace(/^\(출력 없음\)$/, '');
      view.stderr = sections['--- stderr ---'] ?? '';
      return view;
    }
    case 'start_process': {
      const view = { ...base, command: String(input.command ?? '').trim(), emptyText: '백그라운드에서 실행 중' };
      if (failed) return { ...view, stderr: result };
      const id = /\(id: ([^)]+)\)/.exec(result)?.[1];
      if (id) view.badge = { text: `백그라운드 · ${id}`, tone: 'info' };
      return view;
    }
    case 'read_process': {
      const id = String(input.id ?? '').trim();
      const view = { ...base, command: id ? `read_process ${id}` : 'read_process', emptyText: '아직 출력 없음' };
      if (failed) return { ...view, stderr: result };
      if (!id) return { ...view, stdout: result };
      const lines = result.split('\n');
      const status = /^.+? — (.+)$/.exec(lines[0] ?? '')?.[1];
      const command = /^명령: (.+)$/.exec(lines[1] ?? '')?.[1];
      if (command) view.command = command;
      if (status) {
        view.badge = { text: status, tone: /^종료됨 \(코드 0\)|^실행 중/.test(status) ? 'info' : 'error' };
      }
      const sections = splitSections(lines.slice(2).join('\n'), ['--- 출력 ---']);
      view.stdout = (sections['--- 출력 ---'] ?? '').replace(/^\(아직 출력 없음\)$/, '');
      return view;
    }
    case 'stop_process': {
      const match = /^프로세스를 종료했습니다: (\S+) \((.+)\)$/s.exec(result);
      const view = { ...base, command: match?.[2] ?? String(input.id ?? ''), emptyText: '종료했습니다' };
      if (failed) return { ...view, stderr: result };
      if (match) view.badge = { text: `종료 · ${match[1]}`, tone: 'info' };
      return view;
    }
    case 'run_git': {
      const view = { ...base, command: `git ${String(input.args ?? '').trim()}`.trim() };
      return failed ? { ...view, stderr: result } : { ...view, stdout: result };
    }
    default:
      return { ...base, command: row.target ?? '', stdout: result };
  }
}

/** "--- 이름 ---" 구분선으로 나뉜 텍스트를 구역별로 가른다. 첫 구분선 앞은 $head */
function splitSections(text: string, markers: string[]): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = '$head';
  for (const line of text.split('\n')) {
    if (markers.includes(line)) {
      current = line;
      continue;
    }
    sections[current] = sections[current] ? `${sections[current]}\n${line}` : line;
  }
  for (const key of Object.keys(sections)) sections[key] = sections[key].trim();
  return sections;
}

function CommandBlock({ row }: { row: TranscriptRow }) {
  const view = useMemo(
    () => parseCommandView(row),
    [row.name, row.input, row.result, row.target, row.toolStatus],
  );
  const running = row.toolStatus === 'running';
  const commandHtml = useMemo(() => highlightHtml(view.command, 'bash'), [view.command]);

  return (
    <div className="term">
      <div className="term-head">
        <span className="term-prompt">$</span>
        <code className="term-command" dangerouslySetInnerHTML={{ __html: commandHtml }} />
        {view.badge && <span className={`term-badge ${view.badge.tone}`}>{view.badge.text}</span>}
        <CopyButton text={view.command} />
      </div>
      {running ? (
        <div className="term-out term-running">실행 중...</div>
      ) : (
        <>
          {view.stdout && <pre className="term-out">{view.stdout}</pre>}
          {view.stderr && <pre className="term-out stderr">{view.stderr}</pre>}
          {!view.stdout && !view.stderr && <div className="term-out term-empty">{view.emptyText}</div>}
        </>
      )}
    </div>
  );
}


// "[DIR ] name (0바이트)" → "name/", "[FILE] name (123바이트)" → "name"
function formatListing(result: string): string {
  return result
    .split('\n')
    .map(line => {
      const match = /^\[(DIR|FILE)\]\s+(.+?)\s+\(\d+바이트\)$/.exec(line);
      if (!match) return line;
      return match[1] === 'DIR' ? `${match[2]}/` : match[2];
    })
    .join('\n');
}

// read_file 결과의 "파일:/크기:" 머리말을 떼고 본문만 보여줌
function stripReadHeader(result: string): string {
  const separator = result.indexOf('\n---\n');
  if (result.startsWith('파일: ') && separator !== -1) {
    return result.slice(separator + 5);
  }
  return result;
}

/*
 * 상태 줄은 경과 시간과 이 턴의 토큰 사용량만 보여준다. "생각 중...", "답변 작성
 * 중..." 같은 라벨이 계속 갈아끼워지면 정보 없이 소란스럽기만 했다 — 무슨 도구가
 * 도는지는 트랜스크립트의 도구 행이 이미 실시간으로 보여준다. 라벨(재시도 사유
 * 등)은 지우지 않고 툴팁으로 내려 둔다. 누적 컨텍스트는 하단 게이지 링 몫이다.
 */
function StatusLine({ status, turnTokens }: { status: AgentStatus; turnTokens: number | null }) {
  const [, setTick] = useState(0);

  // 경과 시간과 깜빡임을 0.5초마다 갱신
  useEffect(() => {
    const timer = setInterval(() => setTick(previous => previous + 1), 500);
    return () => clearInterval(timer);
  }, [status.startedAt]);

  const elapsed = Math.max(0, Math.floor((Date.now() - status.startedAt) / 1000));
  return (
    <div className="status-line" title={status.label}>
      <span className="status-spinner">*</span> {elapsed}s
      {turnTokens !== null && turnTokens > 0 && <> · {formatTokenCount(turnTokens)} 토큰</>}
    </div>
  );
}

function formatTokenCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}
