import React, { useEffect, useRef, useState } from 'react';
import {
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
} from './Icon.tsx';
import type {
  ContextBreakdownResult,
  PermissionModeEntry,
  ReasoningEffortEntry,
  TokenUsage,
} from '../types.ts';

// 권한 칩: 클릭하면 미니 메뉴가 뜨고, 숫자 키(1~n)로 바로 선택 가능
export function PermissionChip({
  flat,
  label,
  modes,
  onSelect,
  permissionMode,
}: {
  /** 상태 줄에 놓일 때는 테두리 없는 평평한 글자로 (옆의 모델·노력 칩과 통일) */
  flat?: boolean;
  label: string;
  modes: PermissionModeEntry[];
  onSelect: (mode: string) => void;
  permissionMode: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < modes.length) {
        event.preventDefault();
        onSelect(modes[index].value);
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, modes, onSelect]);

  return (
    <span className="chip-anchor">
      {open && <MenuOverlay onClose={() => setOpen(false)} />}
      {/*
        자동이 기본값이라 경고 표시를 붙이지 않는다. 모두에게 상시로 켜져 있는
        경고는 읽히지 않고, 정작 확인이 필요한 승인 창의 무게만 깎는다
      */}
      <button
        className={flat ? 'status-flat' : 'status-chip'}
        onClick={() => setOpen(previous => !previous)}
        title="클릭해서 권한 모드 선택"
        type="button"
      >
        {label}
      </button>
      {open && (
        <div className="chip-menu left">
          <div className="chip-menu-title">모드</div>
          {modes.map((entry, index) => (
            <button
              className="chip-menu-item"
              key={entry.value}
              onClick={() => {
                onSelect(entry.value);
                setOpen(false);
              }}
              type="button"
            >
              <span>{entry.label}</span>
              <span className="chip-menu-key">
                {entry.value === permissionMode && <IconCheck size={13} />}
                {index + 1}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// 노력(추론 강도) 칩 — 코딩 탭 상태 줄용. 채팅 탭은 모델 칩 안의 서브 메뉴로 들어간다
export function EffortChip({
  effort,
  efforts,
  onSelect,
}: {
  effort: string;
  efforts: ReasoningEffortEntry[];
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = efforts.find(entry => entry.value === effort);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < efforts.length) {
        event.preventDefault();
        onSelect(efforts[index].value);
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, efforts, onSelect]);

  return (
    <span className="chip-anchor">
      {open && <MenuOverlay onClose={() => setOpen(false)} />}
      <button
        className="status-flat"
        onClick={() => setOpen(previous => !previous)}
        title="클릭해서 추론 노력 선택"
        type="button"
      >
        {current?.label ?? effort}
      </button>
      {open && (
        <div className="chip-menu right">
          <div className="chip-menu-title">노력</div>
          <EffortItems efforts={efforts} current={effort} onPick={value => {
            onSelect(value);
            setOpen(false);
          }} withKeys />
        </div>
      )}
    </span>
  );
}

function EffortItems({
  current,
  efforts,
  onPick,
  withKeys,
}: {
  current: string;
  efforts: ReasoningEffortEntry[];
  onPick: (value: string) => void;
  withKeys?: boolean;
}) {
  // 설명 줄은 마우스(또는 키보드 포커스)가 올라간 단계를 따라가고, 벗어나면 고른 단계로 돌아온다
  const [hovered, setHovered] = useState<string | null>(null);
  const shown =
    efforts.find(entry => entry.value === hovered) ??
    efforts.find(entry => entry.value === current);
  return (
    <>
      {shown && <div className="chip-menu-hint">{shown.hint}</div>}
      {efforts.map((entry, index) => (
        <button
          className="chip-menu-item"
          key={entry.value}
          onBlur={() => setHovered(null)}
          onClick={() => onPick(entry.value)}
          onFocus={() => setHovered(entry.value)}
          onMouseEnter={() => setHovered(entry.value)}
          onMouseLeave={() => setHovered(null)}
          type="button"
        >
          <span>{entry.label}</span>
          <span className="chip-menu-key">
            {entry.value === current && <IconCheck size={13} />}
            {withKeys && index + 1}
          </span>
        </button>
      ))}
    </>
  );
}

const PRIMARY_MODEL_COUNT = 5;

type SubMenu = 'effort' | 'models';

// 모델 칩: 클릭하면 제공자 선택 + 사용 가능한 모델 목록 미니 메뉴.
// 목록이 길면 앞 몇 개만 보여주고 "더 많은 모델 보기"로 서브 메뉴를 엶.
// effort를 주면(채팅 탭) 칩 라벨에 노력이 붙고 메뉴에 노력 서브 메뉴가 생긴다.
export function ModelChip({
  effort,
  efforts = [],
  model,
  onSelectEffort,
  onSelectProvider,
  onSubmitModel,
  provider,
  providers,
}: {
  /** 현재 추론 강도. null이면 강도가 의미 없는 모델이라 라벨·메뉴에서 뺀다 */
  effort?: string | null;
  efforts?: ReasoningEffortEntry[];
  model: string;
  onSelectEffort?: (value: string) => void;
  onSelectProvider: (name: string) => void;
  onSubmitModel: (name: string) => void;
  provider: string;
  providers: string[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [subOpen, setSubOpen] = useState<SubMenu | null>(null);
  const [subSide, setSubSide] = useState<'left' | 'right'>('left');
  const menuRef = useRef<HTMLDivElement>(null);

  const effortEntry = effort ? efforts.find(entry => entry.value === effort) : undefined;
  const showEffort = effort != null && efforts.length > 0 && Boolean(onSelectEffort);

  // 서브 메뉴가 창 밖으로 잘리지 않는 쪽으로 열기
  function toggleSubMenu(which: SubMenu) {
    if (subOpen !== which && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      setSubSide(window.innerWidth - rect.right > 250 ? 'right' : 'left');
    }
    setSubOpen(previous => (previous === which ? null : which));
  }

  // 메뉴를 열 때, 그리고 제공자가 바뀔 때 모델 목록을 다시 불러옴
  useEffect(() => {
    if (!open) return;
    setModels(null);
    setModelsError('');
    setSubOpen(null);
    let stale = false;
    void window.newbie.models().then(result => {
      if (stale) return;
      setModels(result.models);
      setModelsError(result.error ?? '');
    });
    return () => {
      stale = true;
    };
  }, [open, provider]);

  function pickModel(name: string) {
    if (name !== model) onSubmitModel(name);
    setOpen(false);
  }

  function submitDraft() {
    const trimmed = draft.trim();
    if (trimmed) onSubmitModel(trimmed);
    setDraft('');
    setOpen(false);
  }

  // 현재 모델이 목록에 있으면 앞으로 끌어올려 항상 보이게 함
  const sorted = models
    ? [...models].sort((a, b) => Number(b === model) - Number(a === model))
    : [];
  const primary = sorted.slice(0, PRIMARY_MODEL_COUNT);
  const rest = sorted.slice(PRIMARY_MODEL_COUNT);

  return (
    <span className="chip-anchor">
      {open && <MenuOverlay onClose={() => setOpen(false)} />}
      <button
        className="status-model"
        onClick={() => setOpen(previous => !previous)}
        title={showEffort ? '클릭해서 제공자·모델·노력 변경' : '클릭해서 제공자·모델 변경'}
        type="button"
      >
        <span className="status-model-name">{model}</span>
        {showEffort && (
          <>
            <span className="status-model-effort">{effortEntry?.label ?? effort}</span>
            <IconChevronDown size={12} />
          </>
        )}
      </button>
      {open && (
        <div className="chip-menu right" ref={menuRef}>
          <div className="chip-menu-title">제공자</div>
          {providers.map(name => (
            <button
              className="chip-menu-item"
              key={name}
              onClick={() => onSelectProvider(name)}
              type="button"
            >
              <span>{name}</span>
              <span className="chip-menu-key">
                {name === provider && <IconCheck size={13} />}
              </span>
            </button>
          ))}

          <div className="chip-menu-title model">모델</div>
          {models === null && <div className="chip-menu-note">불러오는 중...</div>}
          {models !== null && modelsError && (
            <div className="chip-menu-note">{modelsError}</div>
          )}
          {models !== null && !modelsError && models.length === 0 && (
            <div className="chip-menu-note">사용 가능한 모델이 없습니다</div>
          )}
          {primary.map(name => (
            <ModelItem current={model} key={name} name={name} onPick={pickModel} />
          ))}

          {showEffort && (
            <span className="chip-submenu-anchor">
              <button
                className="chip-menu-item"
                onClick={() => toggleSubMenu('effort')}
                type="button"
              >
                <span>노력</span>
                <span className="chip-menu-key">
                  <span className="chip-menu-value-name">{effortEntry?.label ?? effort}</span>
                  <SubMenuArrow open={subOpen === 'effort'} side={subSide} />
                </span>
              </button>
              {subOpen === 'effort' && (
                <div className={`chip-submenu ${subSide}`}>
                  <EffortItems
                    current={effort}
                    efforts={efforts}
                    onPick={value => {
                      onSelectEffort?.(value);
                      setOpen(false);
                    }}
                  />
                </div>
              )}
            </span>
          )}

          {rest.length > 0 && (
            <span className="chip-submenu-anchor">
              <button
                className="chip-menu-item"
                onClick={() => toggleSubMenu('models')}
                type="button"
              >
                <span>더 많은 모델 보기</span>
                <span className="chip-menu-key">
                  <SubMenuArrow open={subOpen === 'models'} side={subSide} />
                </span>
              </button>
              {subOpen === 'models' && (
                <div className={`chip-submenu ${subSide}`}>
                  {rest.map(name => (
                    <ModelItem
                      current={model}
                      key={name}
                      name={name}
                      onPick={pickModel}
                    />
                  ))}
                </div>
              )}
            </span>
          )}

          <div className="chip-menu-input">
            <input
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') submitDraft();
                if (event.key === 'Escape') setOpen(false);
              }}
              placeholder="직접 입력"
              value={draft}
            />
            <button onClick={submitDraft} type="button">
              적용
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

function SubMenuArrow({ open, side }: { open: boolean; side: 'left' | 'right' }) {
  if (open) return <IconChevronLeft size={13} />;
  return side === 'right' ? <IconChevronRight size={13} /> : <IconChevronLeft size={13} />;
}

function ModelItem({
  current,
  name,
  onPick,
}: {
  current: string;
  name: string;
  onPick: (name: string) => void;
}) {
  return (
    <button className="chip-menu-item" onClick={() => onPick(name)} type="button">
      <span className="chip-menu-ellipsis">{name}</span>
      <span className="chip-menu-key">
        {name === current && <IconCheck size={13} />}
      </span>
    </button>
  );
}

/**
 * 컨텍스트창 대비 사용량 링. 숫자 두 개(20k / 400k)를 상시로 보여주던 것을
 * 링 하나로 줄였다 — 상태 줄에서 늘 읽을 만큼 중요한 숫자가 아니고, 차오르는
 * 모양만으로 "슬슬 찼다"는 알 수 있다. 클릭하면 컨텍스트 윈도우 팝업이 뜨고,
 * 팝업의 요약 줄을 다시 클릭하면 구성(새 입력·캐시·출력·남은 공간)이 펼쳐진다.
 * 전부 API 실측값이다 (첫 응답 전에는 렌더되지 않음).
 */
export function ContextRing({ tokens }: { tokens: TokenUsage }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(false);
  const ratio = Math.min(1, tokens.used / Math.max(1, tokens.window));
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const className =
    ratio > 0.9 ? 'context-ring danger' : ratio > 0.8 ? 'context-ring warn' : 'context-ring';

  const window_ = Math.max(1, tokens.window);
  const output = Math.max(0, tokens.used - tokens.input);
  const free = Math.max(0, tokens.window - tokens.used);
  const measured = useContextBreakdown(detail, tokens.input);
  const breakdown = measured?.supported ? measured.parts ?? null : null;

  // 구성별 측정이 있으면 입력 한 줄을 네 줄로 쪼갠다. 측정값의 합과 실측 입력이
  // 정확히 같지는 않으므로(요청 뼈대 몇 토큰) 마지막 조각으로 차이를 흡수한다
  const inputRows = breakdown
    ? [
        { color: 'system', label: '시스템 프롬프트', value: breakdown.system },
        { color: 'tools', label: '도구 정의', value: breakdown.tools },
        ...(breakdown.mcpTools > 0
          ? [{ color: 'mcp', label: 'MCP 도구', value: breakdown.mcpTools }]
          : []),
        {
          color: 'input',
          label: '대화',
          value: Math.max(
            0,
            tokens.input - breakdown.system - breakdown.tools - breakdown.mcpTools,
          ),
        },
      ]
    : [{ color: 'input', label: '메시지', value: tokens.input }];

  const rows = [
    ...inputRows,
    { color: 'output', label: '출력', value: output },
    { color: 'free', label: '남은 공간', value: free },
  ];

  return (
    <span className="chip-anchor">
      {open && <MenuOverlay onClose={() => setOpen(false)} />}
      <button
        aria-label="컨텍스트 윈도우"
        className={`context-ring-button ${className}`}
        onClick={() => setOpen(previous => !previous)}
        title="컨텍스트 윈도우"
        type="button"
      >
        <svg height="14" viewBox="0 0 14 14" width="14">
          <circle className="context-ring-track" cx="7" cy="7" r={radius} />
          <circle
            className="context-ring-fill"
            cx="7"
            cy="7"
            r={radius}
            strokeDasharray={`${circumference * ratio} ${circumference}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
      </button>
      {open && (
        <div className="chip-menu right context-window-menu">
          <button
            className="context-window-head"
            onClick={() => setDetail(previous => !previous)}
            type="button"
          >
            <span className="context-window-title">컨텍스트 윈도우</span>
            <span className="context-window-total">
              {formatTokens(tokens.used)} / {formatTokens(tokens.window)} (
              {Math.round(ratio * 100)}%)
            </span>
            {detail ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          </button>
          <div className="context-window-bar">
            {rows
              .filter(row => row.color !== 'free' && row.value > 0)
              .map(row => (
                <span
                  className={`context-seg ${row.color}`}
                  key={row.color}
                  style={{ width: `${(row.value / window_) * 100}%` }}
                />
              ))}
          </div>
          {detail && (
            <div className="context-window-rows">
              {rows.map(row => (
                <div className="context-window-row" key={row.color}>
                  <span className={`context-window-dot ${row.color}`} />
                  <span className="context-window-row-label">{row.label}</span>
                  <span className="context-window-row-value">{formatTokens(row.value)}</span>
                  <span className="context-window-row-pct">
                    {((row.value / window_) * 100).toFixed(1)}%
                  </span>
                </div>
              ))}
              <BreakdownNote result={measured} />
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/**
 * 구성별 측정.
 *
 * 팝업을 펼칠 때만 부른다 — 매 턴 재면 왕복이 아깝고, 값은 다음 라운드가 돌기
 * 전까지 바뀌지 않는다. main이 같은 입력이면 캐시를 돌려주므로 여기서는
 * "펼쳤고, 실측 입력값이 달라졌으면 다시 묻는다" 정도만 관리한다.
 */
function useContextBreakdown(open: boolean, inputTokens: number) {
  const [result, setResult] = useState<ContextBreakdownResult | null>(null);
  /*
   * "무엇을 이미 물어봤는지"는 state가 아니라 ref로 둔다.
   *
   * state로 두고 의존성에 넣으면, effect 안에서 그 값을 바꾸는 순간 effect가
   * 다시 돌면서 먼저 띄운 요청의 정리 함수가 실행된다. alive가 false가 되어
   * 응답이 와도 버려지고, 화면은 영원히 "측정 중"에 머문다. 실제로 그랬다.
   */
  const asked = useRef<number | null>(null);

  useEffect(() => {
    if (!open || asked.current === inputTokens) return;
    asked.current = inputTokens;
    let alive = true;
    void window.newbie.contextBreakdown().then(
      next => {
        if (alive) setResult(next);
      },
      // 거부를 흘려보내면 화면이 "측정 중"에서 영영 멈춘다
      reason => {
        if (alive) {
          setResult({ error: String(reason?.message ?? reason), reason: 'failed', supported: false });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [inputTokens, open]);

  return result;
}

/**
 * 왜 구성이 안 쪼개지는지 알린다.
 *
 * 이유마다 다른 문장을 쓴다. 예전에는 값이 없으면 전부 "지원하지 않습니다"로
 * 뭉뚱그렸는데, 앱을 다시 켜거나 예전 대화를 열면 아직 잰 게 없을 뿐인데도
 * 지원하지 않는다고 알려서 화면이 사실과 다른 말을 했다.
 */
function BreakdownNote({ result }: { result: ContextBreakdownResult | null }) {
  if (result === null) {
    return <div className="context-window-note">구성별 측정 중…</div>;
  }
  /*
   * 총합은 제공자가 실제로 청구한 값이라 정확하다. 추정인 건 그걸 넷으로 쪼갠
   * 쪽이다 — Anthropic이 토큰 계산 결과를 스스로 "estimate"라고 밝히고, 거기에
   * 차분까지 겹친다. 분해를 보여주는 다른 도구들도 같은 이유로 밝힌다.
   */
  if (result.supported) {
    return <div className="context-window-note">구성별 수치는 추정입니다</div>;
  }

  const message =
    result.reason === 'unsupported'
      ? '이 제공자는 구성별 측정을 지원하지 않습니다'
      : result.reason === 'no-turn'
        ? '메시지를 한 번 보내면 구성별로 나눠서 보여줍니다'
        : `구성별 측정에 실패했습니다: ${result.error ?? '알 수 없는 이유'}`;
  return <div className="context-window-note">{message}</div>;
}

export function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

// 메뉴 바깥 클릭 시 닫히게 하는 투명 오버레이
function MenuOverlay({ onClose }: { onClose: () => void }) {
  return <div className="chip-menu-overlay" onClick={onClose} />;
}
