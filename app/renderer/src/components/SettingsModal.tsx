import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { IconChevronDown, IconChevronRight, IconClose } from './Icon.tsx';
import { useTitlebarShade } from '../titlebarShade.ts';
import {
  setThemePreference,
  useOverlayTitlebarColors,
  useThemePreference,
} from '../theme.ts';
import type { ThemePreference } from '../theme.ts';
import type {
  CredentialState,
  McpServerRow,
  McpState,
  PetAnimation,
  PetAnimationSlot,
  PetSettings,
  PetStatus,
  Preferences,
} from '../types.ts';

const THEME_OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'light', label: '라이트', hint: '항상 밝게' },
  { value: 'dark', label: '다크', hint: '항상 어둡게' },
  { value: 'system', label: '시스템', hint: 'OS 설정을 따라감' },
];

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp',
  vllm: 'vLLM',
};

/** 제공자별 기본 모델이 들어가는 환경 변수 */
const MODEL_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic: 'ANTHROPIC_MODEL',
  openai: 'OPENAI_MODEL',
  ollama: 'OLLAMA_MODEL',
  lmstudio: 'LM_STUDIO_MODEL',
  llamacpp: 'LLAMACPP_MODEL',
  vllm: 'VLLM_MODEL',
};

/**
 * 제공자별로 실제 필요한 항목. 고른 제공자 것만 보여준다 — 다섯 제공자의 키와
 * 주소를 한꺼번에 늘어놓으면 지금 쓰는 게 뭔지 알아보기 어렵다.
 * 보이지 않는다고 지워지지는 않는다. 제공자를 다시 고르면 저장된 값이 나온다.
 */
const CREDENTIAL_KEYS_BY_PROVIDER: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  ollama: ['OLLAMA_HOST'],
  lmstudio: ['LM_STUDIO_BASE_URL'],
  llamacpp: ['LLAMACPP_BASE_URL'],
  // vLLM만 둘을 함께 받는다. 주소는 띄울 때 정하는 값이라 기본값이 없고,
  // --api-key로 띄운 서버는 모델 목록 조회에도 키를 요구한다
  vllm: ['VLLM_BASE_URL', 'VLLM_API_KEY'],
};

/** 자격 증명 줄의 화면 문구. 어떤 키를 다루는지는 main의 credentials.ts가 정한다 */
const CREDENTIAL_LABELS: Record<string, { label: string; hint: string; placeholder: string }> = {
  OPENAI_API_KEY: {
    label: 'OpenAI API 키',
    hint: 'platform.openai.com에서 발급합니다',
    placeholder: 'sk-...',
  },
  ANTHROPIC_API_KEY: {
    label: 'Anthropic API 키',
    hint: 'console.anthropic.com에서 발급합니다',
    placeholder: 'sk-ant-...',
  },
  OLLAMA_HOST: {
    label: 'Ollama 주소',
    hint: '보통 http://localhost:11434 입니다',
    placeholder: 'http://localhost:11434',
  },
  LM_STUDIO_BASE_URL: {
    label: 'LM Studio 주소',
    hint: '보통 http://localhost:1234 입니다',
    placeholder: 'http://localhost:1234',
  },
  LLAMACPP_BASE_URL: {
    label: 'llama.cpp 주소',
    hint: '보통 http://localhost:8080 입니다. 뒤에 /v1을 붙이지 마세요',
    placeholder: 'http://localhost:8080',
  },
  VLLM_BASE_URL: {
    label: 'vLLM 주소',
    // llama.cpp와 반대다 — vLLM은 base URL에 /v1까지 포함하는 것이 관례라
    // 그대로 쓴다. 빠뜨리면 404가 나므로 안내에 명시한다
    hint: '끝에 /v1까지 포함해 주세요',
    placeholder: 'http://192.168.0.10:8000/v1',
  },
  VLLM_API_KEY: {
    label: 'vLLM API 키',
    hint: '서버를 --api-key로 띄웠을 때 준 값입니다',
    placeholder: '',
  },
  TAVILY_API_KEY: {
    label: 'Tavily API 키',
    hint: 'web_search 도구가 씁니다. app.tavily.com에서 발급합니다',
    placeholder: 'tvly-...',
  },
  NEWBIE_TEMPERATURE: {
    label: 'temperature',
    hint: '0에 가까울수록 같은 답, 클수록 다양한 답. 비우면 모델 기본값',
    placeholder: '예: 0.7',
  },
  NEWBIE_TOP_P: {
    label: 'top_p',
    hint: '누적 확률이 이 값에 드는 후보만 고릅니다 (0~1). 비우면 모델 기본값',
    placeholder: '예: 0.95',
  },
  NEWBIE_TOP_K: {
    label: 'top_k',
    hint: '확률 상위 몇 개 후보만 고릅니다 (정수). OpenAI는 이 값을 받지 않습니다',
    placeholder: '예: 20',
  },
  NEWBIE_MIN_P: {
    label: 'min_p',
    hint: '가장 높은 확률의 이 비율 미만인 후보를 버립니다 (0~1). 로컬 제공자만 받습니다',
    placeholder: '예: 0',
  },
  NEWBIE_PRESENCE_PENALTY: {
    label: 'presence_penalty',
    hint: '이미 나온 토큰을 다시 쓰는 것을 억제합니다 (-2~2). 로컬 제공자만 받습니다',
    placeholder: '예: 0',
  },
  NEWBIE_REPETITION_PENALTY: {
    label: 'repetition_penalty',
    hint: '반복을 억제합니다. 1이 없음, 1.1 정도가 흔한 값. 로컬 제공자만 받습니다',
    placeholder: '예: 1.0',
  },
};

/**
 * 제공자와 무관하게 늘 보여주는 도구용 키 (웹 검색 묶음). 도구가 부를 때마다
 * 환경에서 읽으므로 저장하면 다음 호출부터 바로 쓰인다
 */
const WEB_SEARCH_KEYS = ['TAVILY_API_KEY'];

/** 샘플링 묶음. 어느 제공자가 무엇을 받는지는 src/providers/sampling.ts가 정한다 */
const SAMPLING_KEYS = [
  'NEWBIE_TEMPERATURE',
  'NEWBIE_TOP_P',
  'NEWBIE_TOP_K',
  'NEWBIE_MIN_P',
  'NEWBIE_PRESENCE_PENALTY',
  'NEWBIE_REPETITION_PENALTY',
];

const TABS = [
  { id: 'general', label: '일반' },
  { id: 'provider', label: '제공자' },
  { id: 'mcp', label: 'MCP' },
  { id: 'pet', label: '펫' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const EMPTY: Preferences = { agentName: '', instructions: '', userName: '' };

/**
 * 저장하지 않은 변경을 닫기 직전에 붙잡기 위한 통로.
 *
 * 닫기 버튼은 설정창이 쥐고 있는데 저장 여부는 탭 안에 있다. 탭이 매 렌더마다
 * 자기 상태를 여기 등록해 두면, 설정창이 닫기 직전에 들여다볼 수 있다.
 * save는 저장에 성공했는지를 돌려준다 — 실패하면 창을 닫지 않아야 한다.
 */
export type SaveGuard = { dirty: boolean; save: () => Promise<boolean> };

const NO_GUARD: SaveGuard = { dirty: false, save: async () => true };

/**
 * 설정창.
 *
 * 프로필 값(이름·지침)은 main 프로세스의 preferences.json에 있고 시스템
 * 프롬프트로 들어간다. 테마만 렌더러 localStorage에 남는데, 첫 페인트 전에
 * 정해져야 팔레트가 번쩍이지 않기 때문이다.
 */
export function SettingsModal({
  initialTab = 'general',
  onClose,
}: {
  /** 처음 보여 줄 탭. 홈 화면의 연결 안내는 제공자 탭을 연다 */
  initialTab?: TabId;
  onClose: () => void;
}) {
  // styles.css의 .settings-overlay 배경과 같은 값이어야 OS 타이틀바가 막과 이어진다
  const shade = useOverlayTitlebarColors(20, 18, 28, 0.82);
  useTitlebarShade(shade.color, shade.symbolColor);
  const [tab, setTab] = useState<TabId>(initialTab);
  const guard = useRef<SaveGuard>(NO_GUARD);
  // 좌측 맨 아래에 지금 쓰는 버전을 보인다. 업데이트를 받았는지, 어떤 빌드로 겪은
  // 문제인지 확인할 곳이 없었다
  const [version, setVersion] = useState('');
  useEffect(() => {
    let alive = true;
    window.newbie
      .appVersion()
      .then(value => {
        if (alive) setVersion(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /*
   * 저장하지 않은 값을 잃을 수 있는 두 길 — 창을 닫는 것과 탭을 옮기는 것.
   *
   * 탭을 옮기면 제공자 탭이 통째로 사라져 입력하던 값도 함께 없어진다.
   * 닫기만 막아 두면 그쪽으로 조용히 새어 나간다.
   */
  const [pending, setPending] = useState<{ kind: 'close' } | { kind: 'tab'; to: TabId } | null>(
    null,
  );

  const leave = useCallback(
    (next: { kind: 'close' } | { kind: 'tab'; to: TabId }) => {
      if (guard.current.dirty) setPending(next);
      else if (next.kind === 'close') onClose();
      else setTab(next.to);
    },
    [onClose],
  );

  const requestClose = useCallback(() => leave({ kind: 'close' }), [leave]);

  /** 확인창에서 고른 뒤 원래 가려던 곳으로 간다 */
  const proceed = useCallback(() => {
    const next = pending;
    setPending(null);
    if (!next) return;
    if (next.kind === 'close') onClose();
    else setTab(next.to);
  }, [onClose, pending]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // 확인창이 떠 있으면 Esc는 그쪽 몫이다
      if (pending) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestClose();
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [pending, requestClose]);

  return (
    <div className="settings-overlay" onClick={requestClose}>
      <div
        aria-label="설정"
        className="settings-modal"
        onClick={event => event.stopPropagation()}
        role="dialog"
      >
        <nav className="settings-rail">
          <div className="settings-rail-title">설정</div>
          {TABS.map(item => (
            <button
              className={`settings-tab${tab === item.id ? ' active' : ''}`}
              key={item.id}
              onClick={() => leave({ kind: 'tab', to: item.id })}
              type="button"
            >
              {item.label}
            </button>
          ))}
          {version && <div className="settings-rail-version">Newbie v{version}</div>}
        </nav>
        <div className="settings-main">
          <button
            aria-label="닫기"
            className="settings-close"
            onClick={requestClose}
            title="닫기 (Esc)"
            type="button"
          >
            <IconClose size={16} />
          </button>
          <div className="settings-body">
            {tab === 'general' && <GeneralTab />}
            {tab === 'provider' && <ProviderTab guard={guard} />}
            {tab === 'mcp' && <McpTab />}
            {tab === 'pet' && <PetTab />}
          </div>
        </div>
      </div>

      {pending && (
        <ConfirmDialog
          cancelLabel="저장 안 함"
          confirmLabel="저장"
          message="저장하지 않은 변경이 있습니다. 저장하시겠습니까?"
          onCancel={proceed}
          onConfirm={() => {
            void guard.current.save().then(saved => {
              // 저장에 실패했으면 자리를 뜨지 않는다 — 오류를 보고 다시 시도해야 한다
              if (saved) proceed();
              else setPending(null);
            });
          }}
          // Esc와 바깥 클릭은 설정창으로 돌아가기만 한다. "저장 안 함"으로
          // 이어지면 두 번 누르다 값을 잃는다
          onEscape={() => setPending(null)}
          tone="primary"
        />
      )}
    </div>
  );
}

function GeneralTab() {
  return (
    <>
      <ProfileSection />
      <ThemeSection />
    </>
  );
}

// ── 프로필: 입력한 값이 그대로 시스템 프롬프트가 된다 ──────────────

function ProfileSection() {
  const { draft, loaded, save, setField } = usePreferences();

  return (
    <section className="settings-group">
      <h2 className="settings-group-title">프로필</h2>

      <SettingsRow
        hint="에이전트가 사용자를 이 이름으로 부릅니다"
        label="성명"
      >
        <input
          className="settings-input"
          disabled={!loaded}
          onBlur={save}
          onChange={event => setField('userName', event.target.value)}
          placeholder="예: 홍길동"
          type="text"
          value={draft.userName}
        />
      </SettingsRow>

      <SettingsRow
        hint="비워 두면 Newbie로 부릅니다"
        label="에이전트 이름"
      >
        <input
          className="settings-input"
          disabled={!loaded}
          onBlur={save}
          onChange={event => setField('agentName', event.target.value)}
          placeholder="Newbie"
          type="text"
          value={draft.agentName}
        />
      </SettingsRow>

      <div className="settings-block">
        <div className="settings-block-head">
          <div className="settings-row-label">Newbie 지침</div>
          <div className="settings-row-hint">
            여기 적은 내용이 매 대화의 시스템 프롬프트로 들어갑니다
          </div>
        </div>
        <textarea
          className="settings-textarea"
          disabled={!loaded}
          onBlur={save}
          onChange={event => setField('instructions', event.target.value)}
          placeholder={
            '예:\n1. 답변은 한국어로 해주세요.\n2. 방법을 제시할 때는 가장 권장하는 것 하나만 알려주세요.'
          }
          rows={7}
          value={draft.instructions}
        />
      </div>
    </section>
  );
}

// ── 환경설정: 지금은 테마만 ─────────────────────────────────────

function ThemeSection() {
  const preference = useThemePreference();

  return (
    <section className="settings-group">
      <h2 className="settings-group-title">환경설정</h2>
      <SettingsRow label="테마">
        <div className="settings-choice">
          {THEME_OPTIONS.map(option => (
            <button
              className={`settings-choice-item${preference === option.value ? ' active' : ''}`}
              key={option.value}
              onClick={() => setThemePreference(option.value)}
              title={option.hint}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </SettingsRow>
    </section>
  );
}

// ── 제공자: API 키와 로컬 서버 주소 ─────────────────────────────

/**
 * 자격 증명 탭.
 *
 * 값은 main 프로세스가 OS 자격 증명 저장소로 암호화해 ~/.newbie에 넣는다.
 * 비밀 항목은 마스킹된 형태로만 내려오므로 입력 칸은 늘 비어 있고, 새로 친
 * 값이 있을 때만 올려보낸다.
 *
 * 저장은 아래 저장 버튼 한 번으로 모은다. 줄마다 즉시 저장하면 언제 반영된
 * 건지 알 수 없어서, 값만 바꾸고 창을 닫아도 되는지 판단할 근거가 없다.
 * 지우기만 예외 — 되돌릴 수 없는 동작이라 누른 그 자리에서 처리한다.
 */
function ProviderTab({ guard }: { guard: React.MutableRefObject<SaveGuard> }) {
  const [state, setState] = useState<CredentialState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  function apply(next: CredentialState) {
    setState(next);
    // 비밀 항목의 칸은 저장 후에도 비워 둔다 — 마스킹 값을 되돌려 넣으면
    // 사용자가 그걸 실제 키로 착각하고 다시 저장하게 된다
    setDrafts(
      Object.fromEntries(next.fields.map(field => [field.key, field.secret ? '' : field.value])),
    );
  }

  useEffect(() => {
    let alive = true;
    void window.newbie.credentials().then(next => {
      if (alive) apply(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 저장에 성공했는지를 돌려준다 — 닫기 확인창이 창을 닫을지 판단하는 근거 */
  function send(patch: Record<string, string>): Promise<boolean> {
    setError('');
    return window.newbie.saveCredentials(patch).then(
      next => {
        apply(next);
        return true;
      },
      reason => {
        setError(String(reason?.message ?? reason));
        return false;
      },
    );
  }

  /** 저장 버튼이 보낼 것 — 바뀐 항목만 모은다 */
  function pendingPatch(): Record<string, string> {
    const patch: Record<string, string> = {};
    for (const field of state?.fields ?? []) {
      // 환경 변수가 잡고 있는 값은 저장해도 무시되므로 아예 보내지 않는다
      if (field.overriddenByEnv) continue;
      const draft = drafts[field.key] ?? '';
      if (field.secret) {
        // 비밀 칸은 늘 비어 있다 — 뭔가 친 경우에만 바뀐 것이다
        if (draft.trim()) patch[field.key] = draft;
      } else if (draft !== field.value) {
        patch[field.key] = draft;
      }
    }
    return patch;
  }

  const patch = pendingPatch();
  const dirty = Object.keys(patch).length > 0;
  const canSave = dirty && state?.available === true;

  // 닫기를 쥔 설정창이 저장 여부를 볼 수 있게 매 렌더마다 갱신한다.
  // 탭을 벗어나면 이 컴포넌트가 사라지므로 등록도 함께 거둔다
  useEffect(() => {
    guard.current = { dirty: canSave, save: () => send(patch) };
    return () => {
      guard.current = NO_GUARD;
    };
  });

  // 제공자는 저장 전에도 화면에 반영한다 — 고르는 즉시 그 제공자의 줄이 나와야
  // 키와 모델을 이어서 채울 수 있다
  const provider = drafts.NEWBIE_PROVIDER ?? '';

  return (
    <section className="settings-group settings-group-fill">
      <h2 className="settings-group-title">제공자</h2>

      {state && !state.available && (
        <div className="settings-warning">
          이 환경에서는 OS 자격 증명 저장소를 쓸 수 없어 키를 저장할 수 없습니다. 환경 변수나
          프로젝트 루트의 .env를 사용하세요.
        </div>
      )}
      {error && <div className="settings-warning">{error}</div>}

      <DefaultProviderRows
        drafts={drafts}
        onSubmit={() => canSave && send(patch)}
        provider={provider}
        setDrafts={setDrafts}
        state={state}
      />

      {renderFields(CREDENTIAL_KEYS_BY_PROVIDER[provider] ?? [])}

      <h2 className="settings-group-title">웹 검색</h2>
      {renderFields(WEB_SEARCH_KEYS)}

      <h2 className="settings-group-title">샘플링</h2>
      {renderFields(SAMPLING_KEYS)}

      <div className="settings-footer">
        {dirty && <span className="settings-row-hint">저장하지 않은 변경이 있습니다</span>}
        <button
          className="settings-save"
          disabled={!canSave}
          onClick={() => send(patch)}
          type="button"
        >
          저장
        </button>
      </div>
    </section>
  );

  /** keys에 든 항목의 입력 줄. 상태에 없는 키는 건너뛴다 */
  function renderFields(keys: string[]) {
    return (state?.fields ?? []).map(field => {
      if (!keys.includes(field.key)) return null;
      const text = CREDENTIAL_LABELS[field.key];
      if (!text) return null;
      const draft = drafts[field.key] ?? '';
      const locked = !state?.available || field.overriddenByEnv;

      return (
        <SettingsRow
          hint={
            field.overriddenByEnv
              ? '.env나 환경 변수가 이 값을 잡고 있어 저장값은 무시됩니다'
              : field.secret && field.present
                ? `저장됨 · ${field.value}`
                : text.hint
          }
          key={field.key}
          label={text.label}
        >
          <div className="settings-secret">
            <input
              className="settings-input"
              disabled={locked}
              onChange={event =>
                setDrafts(previous => ({ ...previous, [field.key]: event.target.value }))
              }
              // 키를 붙여 넣고 엔터를 치는 흐름이 자연스럽다
              onKeyDown={event => {
                if (event.key === 'Enter' && canSave) send(patch);
              }}
              placeholder={field.secret && field.present ? field.value : text.placeholder}
              type={field.secret ? 'password' : 'text'}
              value={draft}
            />
            {field.present && !locked && (
              <button
                className="settings-clear"
                onClick={() => send({ [field.key]: '' })}
                title="저장된 값을 즉시 지웁니다"
                type="button"
              >
                지우기
              </button>
            )}
          </div>
        </SettingsRow>
      );
    });
  }
}

/** 서버 상태를 화면 문구로. 상태 이름을 그대로 내보내면 뜻이 통하지 않는다 */
const MCP_STATE_LABELS: Record<McpServerRow['state'], string> = {
  connected: '연결됨',
  disabled: '사용 안 함',
  failed: '실패',
  'needs-auth': '인증 필요',
};

/**
 * MCP 탭.
 *
 * 서버 추가·수정은 설정 파일(~/.newbie/mcp.json)에서 한다 — 다른 MCP 클라이언트와
 * 같은 형식이라 남의 설정을 그대로 옮겨 붙일 수 있고, 이 앱만의 폼을 따로 만들면
 * 그 호환이 깨진다. 화면은 파일을 열어 주고, 고친 뒤의 결과를 보여주는 몫만 맡는다.
 */
function McpTab() {
  const [state, setState] = useState<McpState | null>(null);
  /** 지금 진행 중인 작업. '' 이면 없음, 그 외에는 서버 이름이나 'all' */
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void window.newbie.mcpStatus().then(next => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  function run(label: string, action: () => Promise<McpState>) {
    if (busy) return;
    setBusy(label);
    setError('');
    void action().then(
      next => {
        setState(next);
        setBusy('');
      },
      reason => {
        setError(String(reason?.message ?? reason));
        setBusy('');
      },
    );
  }

  function openConfig() {
    setError('');
    void window.newbie.mcpOpenConfig().then(result => {
      if (result.error) setError(result.error);
    });
  }

  const servers = state?.servers ?? [];

  return (
    <section className="settings-group settings-group-fill">
      <h2 className="settings-group-title">MCP 서버</h2>

      <div className="settings-block">
        <div className="settings-block-head">
          <div className="settings-row-hint">
            설정 파일에 서버를 적어 두면 앱을 켤 때 연결합니다. 파일을 고친 뒤에는 다시
            연결을 누르세요 — 앱을 껐다 켤 필요는 없습니다
          </div>
        </div>
        {state && <code className="mcp-path">{state.configPath}</code>}
        <div className="mcp-actions">
          <button className="settings-save" onClick={openConfig} type="button">
            설정 파일 열기
          </button>
          <button
            className="settings-clear"
            disabled={busy !== ''}
            onClick={() => run('all', () => window.newbie.mcpReconnect())}
            type="button"
          >
            {busy === 'all' ? '연결 중...' : '다시 연결'}
          </button>
        </div>
      </div>

      {error && <div className="settings-warning">{error}</div>}
      {(state?.problems ?? []).map(problem => (
        <div className="settings-warning" key={problem}>
          {problem}
        </div>
      ))}

      {state && servers.length === 0 && (
        <div className="settings-warning">
          등록된 서버가 없습니다. 설정 파일을 열어 서버를 추가하고 다시 연결을 누르세요.
        </div>
      )}

      {servers.map(server => (
        <McpServerCard
          busy={busy}
          key={server.name}
          onAuth={() => run(server.name, () => window.newbie.mcpAuth(server.name))}
          onReconnect={() => run(server.name, () => window.newbie.mcpReconnect(server.name))}
          server={server}
        />
      ))}

      <McpSecretsSection />
    </section>
  );
}

function McpServerCard({
  busy,
  onAuth,
  onReconnect,
  server,
}: {
  busy: string;
  onAuth: () => void;
  onReconnect: () => void;
  server: McpServerRow;
}) {
  const working = busy === server.name;
  return (
    <div className="mcp-server">
      <div className="mcp-server-head">
        <span className={`mcp-dot mcp-dot-${server.state}`} />
        <span className="mcp-server-name">{server.name}</span>
        <span className="mcp-server-state">{MCP_STATE_LABELS[server.state]}</span>
        <div className="mcp-server-actions">
          {server.state === 'needs-auth' && (
            <button className="settings-save" disabled={busy !== ''} onClick={onAuth} type="button">
              {working ? '승인 대기 중...' : '인증'}
            </button>
          )}
          <button
            className="settings-clear"
            disabled={busy !== ''}
            onClick={onReconnect}
            type="button"
          >
            {working && server.state !== 'needs-auth' ? '연결 중...' : '다시 연결'}
          </button>
        </div>
      </div>
      <div className="mcp-server-meta">
        {server.target}
        {server.state === 'connected' && ` · 도구 ${server.toolCount}개`}
        {/* 지연 로딩은 도구 정의가 무거워 매 요청에 싣지 않는다는 뜻이다 */}
        {server.deferred && ' · 필요할 때 불러옴'}
      </div>
      {/* needs-auth의 error는 "/mcp auth <서버>로 승인해주세요"라는 슬래시 명령
          안내라, 인증 버튼이 있는 이 화면에서는 같은 말을 두 번 하게 된다 */}
      {server.state !== 'needs-auth' && server.error && (
        <div className="mcp-server-error">{server.error}</div>
      )}
      {server.state === 'needs-auth' && (
        <div className="mcp-server-error">
          인증을 누르면 브라우저에서 승인 화면이 열립니다. 승인 후 이 창으로 돌아오세요
        </div>
      )}
    </div>
  );
}

/** 비밀값 목록은 자격 증명 저장소에 있어 MCP 상태와 따로 읽는다 */
function McpSecretsSection() {
  const [state, setState] = useState<CredentialState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void window.newbie.credentials().then(next => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  function send(patch: Record<string, string>): Promise<boolean> {
    setError('');
    return window.newbie.saveCredentials(patch).then(
      next => {
        setState(next);
        return true;
      },
      reason => {
        setError(String(reason?.message ?? reason));
        return false;
      },
    );
  }

  return (
    <>
      {error && <div className="settings-warning">{error}</div>}
      <McpSecrets send={send} state={state} />
    </>
  );
}

/**
 * 무엇을 넣는 자리인지 실물로 보여준다.
 *
 * 말로 설명하면 ${} 치환이 뭔지부터 알아야 한다. 설정 파일이 어떻게 바뀌는지
 * 전후로 보여주는 편이 짧고 확실하다.
 */
function McpExample({ prefix }: { prefix: string }) {
  return (
    <div className="mcp-example">
      <div className="mcp-example-step">
        1. 지금 <code>mcp.json</code>에 토큰을 이렇게 적고 있다면
      </div>
      <pre className="mcp-example-code">
        {'"headers": { "Authorization": "Bearer secret_abc123" }'}
      </pre>

      <div className="mcp-example-step">
        2. 아래에 이름 <code>NOTION_TOKEN</code>, 값 <code>secret_abc123</code>을 넣고 추가
      </div>

      <div className="mcp-example-step">3. 나온 문자열로 파일을 이렇게 바꿉니다</div>
      <pre className="mcp-example-code">
        {`"headers": { "Authorization": "Bearer \${${prefix}NOTION_TOKEN}" }`}
      </pre>
    </div>
  );
}

/**
 * 저장된 비밀값 한 줄.
 *
 * 이름과 마스킹된 값 대신 "설정 파일에 이걸 붙여넣으세요"를 그대로 보여준다.
 * ${...} 치환이 무엇인지 설명하는 것보다 복사할 문자열을 주는 편이 빠르다.
 */
function SecretRow({
  onDelete,
  secret,
}: {
  onDelete: () => void;
  secret: { name: string; masked: string };
}) {
  const [copied, setCopied] = useState(false);
  const paste = `\${${secret.name}}`;

  return (
    <div className="settings-secret settings-secret-row">
      <code className="settings-secret-name">{paste}</code>
      <span className="settings-row-hint">{secret.masked}</span>
      <button
        className="settings-clear"
        onClick={() => {
          void navigator.clipboard.writeText(paste).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        type="button"
      >
        {copied ? '복사됨' : '복사'}
      </button>
      <button
        className="settings-clear"
        onClick={onDelete}
        title="저장된 값을 즉시 지웁니다"
        type="button"
      >
        지우기
      </button>
    </div>
  );
}

/**
 * MCP 서버가 쓸 비밀값.
 *
 * MCP 설정(~/.newbie/mcp.json)은 평문 파일이라 토큰을 그대로 적으면 그대로
 * 샌다. 그 파일이 ${VAR} 치환을 지원하므로, 값은 여기 암호화해 두고 파일에는
 * 이름만 적게 한다. 지우기는 되돌릴 수 없어 누른 자리에서 바로 처리한다.
 */
function McpSecrets({
  send,
  state,
}: {
  send: (patch: Record<string, string>) => Promise<boolean>;
  state: CredentialState | null;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [showExample, setShowExample] = useState(false);
  if (!state?.available) return null;

  // 한 필드가 비었다고 설정 탭 전체가 죽으면 안 된다
  const prefix = state.customPrefix ?? 'NEWBIE_SECRET_';
  const secrets = state.custom ?? [];
  const cleaned = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const canAdd = cleaned !== '' && value.trim() !== '';

  function add() {
    if (!canAdd) return;
    void send({ [`${prefix}${cleaned}`]: value }).then(saved => {
      if (!saved) return;
      setName('');
      setValue('');
    });
  }

  return (
    <>
      <div className="settings-block">
        <div className="settings-block-head">
          <div className="settings-row-label">MCP 비밀값</div>
          <div className="settings-row-hint">
            MCP 서버에 쓰는 토큰을 암호화해 보관합니다. 추가하면 설정 파일에 붙여넣을
            문자열이 나옵니다
          </div>
          <button
            className="row-error-toggle"
            onClick={() => setShowExample(value => !value)}
            type="button"
          >
            {showExample ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
            예시
          </button>
          {showExample && <McpExample prefix={prefix} />}
        </div>

        {secrets.map(item => (
          <SecretRow key={item.name} onDelete={() => void send({ [item.name]: '' })} secret={item} />
        ))}

        <div className="settings-secret">
          <span className="settings-secret-prefix">{prefix}</span>
          <input
            className="settings-input settings-input-name"
            onChange={event => setName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') add();
            }}
            placeholder="NOTION_TOKEN"
            type="text"
            value={name}
          />
          <input
            className="settings-input"
            onChange={event => setValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') add();
            }}
            placeholder="값"
            type="password"
            value={value}
          />
          <button className="settings-save" disabled={!canAdd} onClick={add} type="button">
            추가
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * 기본 제공자와 그 제공자의 기본 모델.
 *
 * 여기서 정한 값이 새 대화의 시작값이 된다. 모델 칩으로 바꾼 값은 그 대화에만
 * 남고(controller의 persistConfig), 앱은 켤 때마다 새 대화로 시작하므로
 * (config.ts의 createSession은 resume/continue 인자가 있을 때만 복원한다)
 * 설정에 없으면 매번 코드 기본값으로 돌아간다.
 *
 * 모델 줄은 제공자마다 늘어놓지 않고 지금 고른 제공자 것만 보여준다.
 */
function DefaultProviderRows({
  drafts,
  onSubmit,
  provider,
  setDrafts,
  state,
}: {
  drafts: Record<string, string>;
  onSubmit: () => void;
  provider: string;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  state: CredentialState | null;
}) {
  const providerField = state?.fields.find(field => field.key === 'NEWBIE_PROVIDER');
  const modelKey = MODEL_KEY_BY_PROVIDER[provider] ?? '';
  const modelField = state?.fields.find(field => field.key === modelKey);

  /*
   * 그 제공자에 필요한 값(키 또는 서버 주소)이 저장돼 있어야 목록을 물어본다.
   *
   * 로컬 서버는 기본 주소가 있으니 바로 조회해도 된다고 봤는데, 서버가 떠 있지
   * 않으면 사용자가 시킨 적 없는 요청이 실패하고 그 실패가 오류로 화면에 뜬다.
   * 주소를 넣은 적도 없는데 "불러오지 못했습니다"가 뜨는 건 사실과도 안 맞는다.
   * 원격이든 로컬이든 같은 규칙으로 둔다 — 저장한 뒤에 조회한다.
   */
  const credentialKeys = CREDENTIAL_KEYS_BY_PROVIDER[provider] ?? [];
  // vLLM은 주소와 키가 둘 다 있어야 한다. 하나만 채운 채로 조회하면 사용자가
  // 시킨 적 없는 요청이 실패하고, 그 실패가 오류로 화면에 뜬다
  const credentialReady =
    credentialKeys.length > 0 &&
    credentialKeys.every(key => state?.fields.find(f => f.key === key)?.present === true);
  /** 무엇을 받는 제공자인지 — 안내 문구가 달라진다. vLLM만 둘 다 참이다 */
  const needsKey = credentialKeys.some(key => key.endsWith('API_KEY'));
  const needsUrl = credentialKeys.some(key => key.endsWith('_URL') || key.endsWith('_HOST'));

  const providerLocked = !state?.available || providerField?.overriddenByEnv === true;
  // 키가 없으면 모델을 물어볼 수도, 골라 봐야 쓸 수도 없다 — 칸 자체를 막는다
  const modelLocked =
    !state?.available || modelField?.overriddenByEnv === true || !credentialReady;
  const modelDraft = drafts[modelKey] ?? '';

  const { error: modelsError, loading: modelsLoading, models } = useProviderModels(
    provider,
    credentialReady,
  );

  // 고른 값이 목록에 없을 수 있다 — 별칭(claude-haiku-4-5)과 API가 돌려주는
  // 날짜 붙은 ID(claude-haiku-4-5-20251001)는 다르다. 그대로 선택지에 남긴다
  const options = modelDraft && !models.includes(modelDraft) ? [modelDraft, ...models] : models;

  return (
    <>
      <SettingsRow
        hint={
          providerField?.overriddenByEnv
            ? '.env나 환경 변수가 이 값을 잡고 있어 저장값은 무시됩니다'
            : '새 대화가 이 제공자로 시작합니다'
        }
        label="기본 제공자"
      >
        <div className="settings-choice compact">
          {(state?.providers ?? []).map(name => (
            <button
              className={`settings-choice-item${provider === name ? ' active' : ''}`}
              disabled={providerLocked}
              key={name}
              onClick={() => setDrafts(previous => ({ ...previous, NEWBIE_PROVIDER: name }))}
              type="button"
            >
              {PROVIDER_LABELS[name] ?? name}
            </button>
          ))}
        </div>
      </SettingsRow>

      {modelField && (
        <SettingsRow
          hint={modelHint({
            error: modelsError,
            loading: modelsLoading,
            needsKey,
            needsUrl,
            overriddenByEnv: modelField.overriddenByEnv,
            provider,
            ready: credentialReady,
          })}
          label="기본 모델"
        >
          {options.length > 0 ? (
            <select
              className="settings-select"
              disabled={modelLocked}
              onChange={event =>
                setDrafts(previous => ({ ...previous, [modelKey]: event.target.value }))
              }
              value={modelDraft}
            >
              <option value="">제공자 기본 모델 사용</option>
              {options.map(name => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            // 목록을 못 받는 경우(로컬 서버 꺼짐, 조회 실패)에도 모델 이름을
            // 직접 적을 수 있어야 한다. 키가 없을 때는 modelLocked로 막힌다
            <input
              className="settings-input"
              disabled={modelLocked}
              onChange={event =>
                setDrafts(previous => ({ ...previous, [modelKey]: event.target.value }))
              }
              onKeyDown={event => {
                if (event.key === 'Enter') onSubmit();
              }}
              // 막힌 칸에는 예시 글자도 남기지 않는다. 흐릿하게라도 글자가 있으면
              // 입력할 수 있는 칸처럼 보여서 눌러 보게 된다
              placeholder={modelLocked ? '' : '예: claude-haiku-4-5'}
              type="text"
              value={modelDraft}
            />
          )}
        </SettingsRow>
      )}
    </>
  );
}

/**
 * 고른 제공자의 모델 목록.
 *
 * 키(또는 로컬 서버 주소)가 준비됐을 때만 물어본다. ready가 false→true로
 * 바뀌는 순간이 곧 "키를 저장한 직후"라, 저장하면 목록이 알아서 채워진다.
 */
function useProviderModels(provider: string, ready: boolean) {
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setModels([]);
    setError('');
    if (!provider || !ready) return;

    let alive = true;
    setLoading(true);
    void window.newbie.providerModels(provider).then(
      result => {
        if (!alive) return;
        setModels(result.models);
        setError(result.error ?? '');
        setLoading(false);
      },
      reason => {
        if (!alive) return;
        setError(String(reason?.message ?? reason));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [provider, ready]);

  return { error, loading, models };
}

function modelHint({
  error,
  loading,
  needsKey,
  needsUrl,
  overriddenByEnv,
  provider,
  ready,
}: {
  error: string;
  loading: boolean;
  needsKey: boolean;
  needsUrl: boolean;
  overriddenByEnv: boolean;
  provider: string;
  ready: boolean;
}): string {
  const label = PROVIDER_LABELS[provider] ?? provider;
  if (overriddenByEnv) return '.env나 환경 변수가 이 값을 잡고 있어 저장값은 무시됩니다';
  if (!ready) {
    // vLLM은 주소와 키를 함께 받는다. 하나만 말하면 나머지를 채워도 왜 아직
    // 막혀 있는지 알 수 없다
    if (needsKey && needsUrl) return '주소와 API 키를 저장하면 모델을 목록에서 고를 수 있습니다';
    return needsKey
      ? 'API 키를 저장하면 모델을 목록에서 고를 수 있습니다'
      : '서버 주소를 저장하면 모델을 목록에서 고를 수 있습니다';
  }
  if (loading) return '모델 목록을 불러오는 중…';
  if (error) return `모델 목록을 불러오지 못했습니다: ${error}`;
  return `비워 두면 ${label}의 기본 모델을 씁니다`;
}

// ── 공통 ────────────────────────────────────────────────────────

// ── 펫: 데스크탑 펫 프로세스 ─────────────────────────────────

/**
 * 펫 플립북 시퀀스 하나(기본 / 돌아다니기)를 고치는 칸 묶음.
 *
 * 낱장 여러 장이나 격자 시트 한 장 중 하나를 쓴다. 숫자 칸은 벗어날 때 저장한다 —
 * "12"를 치는 중간에 1칸으로 잘리거나, "140"을 치는 중간에 1ms로 저장되지 않게.
 */
function PetAnimationEditor({
  animation,
  busy,
  hint,
  label,
  onRun,
  slot,
}: {
  animation: PetAnimation;
  busy: boolean;
  hint: string;
  label: string;
  onRun: (action: () => Promise<PetSettings>) => void;
  slot: PetAnimationSlot;
}) {
  const [frameMsDraft, setFrameMsDraft] = useState(String(animation.frameMs));
  const [columnsDraft, setColumnsDraft] = useState(String(animation.sheetColumns));
  const [rowsDraft, setRowsDraft] = useState(String(animation.sheetRows));

  // 저장된 값이 바뀌면(범위 밖 값을 main이 묶었거나, 시트 파일 이름에서 칸 수를 채웠거나) 칸도 따른다
  useEffect(() => setFrameMsDraft(String(animation.frameMs)), [animation.frameMs]);
  useEffect(() => setColumnsDraft(String(animation.sheetColumns)), [animation.sheetColumns]);
  useEffect(() => setRowsDraft(String(animation.sheetRows)), [animation.sheetRows]);

  const hasSheet = Boolean(animation.sheet);
  const empty = !hasSheet && animation.frames.length === 0;

  function saveNumber(
    key: 'frameMs' | 'sheetColumns' | 'sheetRows',
    draft: string,
    reset: (value: string) => void,
  ) {
    const value = Number(draft);
    if (!Number.isFinite(value) || value <= 0 || value === animation[key]) {
      reset(String(animation[key]));
      return;
    }
    onRun(() => window.newbie.petSetAnimation(slot, { [key]: value }));
  }

  const numberInput = (
    ariaLabel: string,
    key: 'frameMs' | 'sheetColumns' | 'sheetRows',
    draft: string,
    setDraft: (value: string) => void,
    limits: { min: number; max: number; step?: number },
    disabled: boolean,
  ) => (
    <input
      aria-label={ariaLabel}
      className="settings-input settings-input-short"
      disabled={busy || disabled}
      max={limits.max}
      min={limits.min}
      onBlur={() => saveNumber(key, draft, setDraft)}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      step={limits.step}
      type="number"
      value={draft}
    />
  );

  return (
    <>
      <div className="settings-block">
        <div className="settings-block-head">
          <div className="settings-row-label">{label}</div>
          <div className="settings-row-hint">
            {hint}. 낱장은 여러 장을 한 번에 골라 파일 이름 순(walk1, walk2, … walk10)으로,
            시트(png, jpg)는 칸마다 잘라 왼쪽→오른쪽, 위→아래 순으로 넘깁니다. 시트의 빈 칸은
            건너뛰고, 파일 이름에 8x8처럼 격자가 있으면 칸 수를 채웁니다
          </div>
        </div>
        <code className="mcp-path">
          {hasSheet
            ? `시트 · ${animation.sheet}`
            : animation.frames.length > 0
              ? `낱장 ${animation.frames.length}장 · ${animation.frames[0]}${
                  animation.frames.length > 1 ? ' …' : ''
                }`
              : '없음'}
        </code>
        <div className="mcp-actions">
          <button
            className="settings-save"
            disabled={busy}
            onClick={() => onRun(() => window.newbie.petPickFrames(slot))}
            type="button"
          >
            낱장 선택...
          </button>
          <button
            className="settings-save"
            disabled={busy}
            onClick={() => onRun(() => window.newbie.petPickSheet(slot))}
            type="button"
          >
            시트 선택...
          </button>
          <button
            className="settings-clear"
            disabled={busy || empty}
            onClick={() => onRun(() => window.newbie.petClearAnimation(slot))}
            type="button"
          >
            비우기
          </button>
        </div>
      </div>

      <SettingsRow label={`${label} 시트 칸 수`} hint="가로 × 세로 칸 수입니다(한 변 1~16)">
        {numberInput(
          '가로 칸 수',
          'sheetColumns',
          columnsDraft,
          setColumnsDraft,
          { min: 1, max: 16 },
          !hasSheet,
        )}
        <span className="settings-input-unit">×</span>
        {numberInput(
          '세로 칸 수',
          'sheetRows',
          rowsDraft,
          setRowsDraft,
          { min: 1, max: 16 },
          !hasSheet,
        )}
        <span className="settings-input-unit">칸</span>
      </SettingsRow>

      <SettingsRow
        label={`${label} 프레임 시간`}
        hint="한 장을 보여 주는 시간입니다(40~1000ms). 짧을수록 빠르게 넘어갑니다"
      >
        {numberInput(
          '프레임 시간',
          'frameMs',
          frameMsDraft,
          setFrameMsDraft,
          { min: 40, max: 1000, step: 10 },
          empty,
        )}
        <span className="settings-input-unit">ms</span>
      </SettingsRow>
    </>
  );
}

/**
 * 펫 탭.
 *
 * 펫은 본앱과 다른 프로세스라 여기서 바로 조작할 수 없다. 값은 pet.json에 쓰고
 * main이 펫에 신호를 보낸다. 저장 버튼이 없다 — 누르는 즉시 적용되므로
 * SaveGuard도 등록하지 않는다.
 */
function PetTab() {
  const [settings, setSettings] = useState<PetSettings | null>(null);
  const [status, setStatus] = useState<PetStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 간격은 숫자 칸을 벗어날 때 저장한다 — 글자마다 저장하면 "6"을 치는 중간에
  // 60이 6으로 바뀌어 펫이 6분마다 말을 건다
  const [intervalDraft, setIntervalDraft] = useState('');

  const refreshStatus = useCallback(() => {
    void window.newbie.petStatus().then(setStatus, () => setStatus(null));
  }, []);

  useEffect(() => {
    let alive = true;
    void window.newbie.petSettings().then(next => {
      if (!alive) return;
      setSettings(next);
      setIntervalDraft(String(next.intervalMinutes));
    });
    refreshStatus();
    // 펫이 별도 프로세스라 켜지고 꺼지는 시점을 여기서 알 수 없다. 탭이 열려 있는
    // 동안만 가볍게 다시 읽는다 (pid 확인과 파일 두 개)
    const timer = setInterval(refreshStatus, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refreshStatus]);

  function run(action: () => Promise<PetSettings>) {
    if (busy) return;
    setBusy(true);
    setError('');
    void action().then(
      next => {
        setSettings(next);
        setIntervalDraft(String(next.intervalMinutes));
        setBusy(false);
        // spawn 직후라 pid 파일이 아직 없을 수 있다. 주기 갱신이 곧 따라잡는다
        refreshStatus();
      },
      reason => {
        setError(String(reason?.message ?? reason));
        setBusy(false);
      },
    );
  }

  function saveInterval() {
    const value = Number(intervalDraft);
    if (!Number.isFinite(value) || value < 1 || value === settings?.intervalMinutes) {
      setIntervalDraft(String(settings?.intervalMinutes ?? ''));
      return;
    }
    run(() => window.newbie.petSetOptions({ intervalMinutes: value }));
  }

  function saveQuietHours(patch: Partial<PetSettings['quietHours']>) {
    if (!settings) return;
    run(() => window.newbie.petSetOptions({ quietHours: { ...settings.quietHours, ...patch } }));
  }

  if (!settings) return <section className="settings-group" />;

  return (
    <section className="settings-group">
      <h2 className="settings-group-title">데스크탑 펫</h2>

      {status && (
        <SettingsRow
          label="상태"
          hint="펫이 안 보일 때 여기서 원인을 확인합니다. 체크인과 질문은 CLI와 같은 기록입니다"
        >
          <span className="mcp-server-state">
            {status.running ? '실행 중' : '꺼져 있음'}
            {' · '}
            {status.hasTodayCheckin ? '오늘 체크인 완료' : '오늘 체크인 전'}
            {' · '}
            {status.pendingQuestions > 0
              ? `대기 질문 ${status.pendingQuestions}개`
              : '대기 질문 없음'}
          </span>
        </SettingsRow>
      )}

      <SettingsRow
        label="펫 표시"
        hint="켜면 앱 시작과 함께 뜹니다. 앱을 닫아도 펫은 남고, 펫의 ✕가 이 값을 끕니다"
      >
        <div className="settings-choice">
          <button
            className={`settings-choice-item${settings.enabled ? ' active' : ''}`}
            disabled={busy}
            onClick={() => run(() => window.newbie.petSetEnabled(true))}
            type="button"
          >
            켜기
          </button>
          <button
            className={`settings-choice-item${settings.enabled ? '' : ' active'}`}
            disabled={busy}
            onClick={() => run(() => window.newbie.petSetEnabled(false))}
            type="button"
          >
            끄기
          </button>
        </div>
      </SettingsRow>

      <SettingsRow
        label="확인 질문 묻기"
        hint="/distill이 만든 확인 질문을 펫이 물어봅니다. 꺼도 오늘의 기분 체크인은 그대로 권합니다"
      >
        <div className="settings-choice">
          <button
            className={`settings-choice-item${settings.askQuestions ? ' active' : ''}`}
            disabled={busy}
            onClick={() => run(() => window.newbie.petSetAskQuestions(true))}
            type="button"
          >
            켜기
          </button>
          <button
            className={`settings-choice-item${settings.askQuestions ? '' : ' active'}`}
            disabled={busy}
            onClick={() => run(() => window.newbie.petSetAskQuestions(false))}
            type="button"
          >
            끄기
          </button>
        </div>
      </SettingsRow>

      <SettingsRow
        label="체크인 권유"
        hint="오늘 체크인이 없으면 기분을 묻습니다. 꺼도 CLI /checkin으로는 그대로 기록할 수 있습니다"
      >
        <div className="settings-choice">
          <button
            className={`settings-choice-item${settings.askCheckin ? ' active' : ''}`}
            disabled={busy}
            onClick={() => run(() => window.newbie.petSetOptions({ askCheckin: true }))}
            type="button"
          >
            켜기
          </button>
          <button
            className={`settings-choice-item${settings.askCheckin ? '' : ' active'}`}
            disabled={busy}
            onClick={() => run(() => window.newbie.petSetOptions({ askCheckin: false }))}
            type="button"
          >
            끄기
          </button>
        </div>
      </SettingsRow>

      <SettingsRow
        label="돌아다니기"
        hint="가끔 화면을 옆으로 천천히 걸어 다닙니다. 말을 걸거나 커서를 올리면 멈춥니다"
      >
        <div className="settings-choice">
          <button
            className={`settings-choice-item${settings.roam ? ' active' : ''}`}
            disabled={busy}
            onClick={() => run(() => window.newbie.petSetOptions({ roam: true }))}
            type="button"
          >
            켜기
          </button>
          <button
            className={`settings-choice-item${settings.roam ? '' : ' active'}`}
            disabled={busy}
            onClick={() => run(() => window.newbie.petSetOptions({ roam: false }))}
            type="button"
          >
            끄기
          </button>
        </div>
      </SettingsRow>

      <SettingsRow
        label="확인 간격"
        hint="이 간격으로 질문이나 체크인을 권합니다. 답하거나 넘기면 다음 확인은 그만큼 뒤로 밀립니다"
      >
        <input
          className="settings-input settings-input-short"
          disabled={busy}
          min={1}
          onBlur={saveInterval}
          onChange={event => setIntervalDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          type="number"
          value={intervalDraft}
        />
        <span className="settings-input-unit">분</span>
      </SettingsRow>

      <SettingsRow
        label="조용한 시간"
        hint="이 시간대에는 말을 걸지 않습니다. 자정을 넘는 구간도 됩니다. 시작과 끝이 같으면 조용한 시간이 없습니다"
      >
        <div className="settings-time-range">
          <input
            className="settings-input settings-input-short"
            disabled={busy}
            onChange={event => saveQuietHours({ start: event.target.value })}
            type="time"
            value={settings.quietHours.start}
          />
          <span className="settings-input-unit">~</span>
          <input
            className="settings-input settings-input-short"
            disabled={busy}
            onChange={event => saveQuietHours({ end: event.target.value })}
            type="time"
            value={settings.quietHours.end}
          />
        </div>
      </SettingsRow>

      <div className="settings-block">
        <div className="settings-block-head">
          <div className="settings-row-label">펫 이미지</div>
          <div className="settings-row-hint">
            내 컴퓨터의 이미지(png, jpg, gif, webp, svg)를 펫으로 씁니다. 표정 변화와 색은
            이미지에는 적용되지 않고 흔들림·끌기 같은 동작만 남습니다. 파일을 고친 뒤에는
            새로고침을 누르세요
          </div>
        </div>
        <code className="mcp-path">{settings.image || '기본 얼굴'}</code>
        <div className="mcp-actions">
          <button
            className="settings-save"
            disabled={busy}
            onClick={() => run(() => window.newbie.petPickImage())}
            type="button"
          >
            이미지 선택...
          </button>
          <button
            className="settings-clear"
            disabled={busy || !settings.image}
            onClick={() => run(() => window.newbie.petClearImage())}
            type="button"
          >
            기본 얼굴로
          </button>
          <button
            className="settings-clear"
            disabled={busy}
            onClick={() => run(() => window.newbie.petReload())}
            type="button"
          >
            새로고침
          </button>
        </div>
      </div>

      <PetAnimationEditor
        animation={settings.animations.idle}
        busy={busy}
        hint="걷지 않을 때 늘 넘기는 시퀀스입니다. 가만히 있어도 숨 쉬듯 미세하게 움직이면 살아 있는 것처럼 보입니다. 비어 있으면 펫 이미지(없으면 기본 얼굴)가 보입니다"
        label="기본 시퀀스"
        onRun={run}
        slot="idle"
      />

      <PetAnimationEditor
        animation={settings.animations.walk}
        busy={busy}
        hint="돌아다니기로 걷는 동안만 넘기고, 멈추면 기본 시퀀스로 돌아갑니다. 비어 있으면 걷는 동안에도 기본 시퀀스를 넘기며 뒤뚱거립니다. 오른쪽을 보는 그림으로 넣으면 왼쪽으로 갈 때 뒤집습니다"
        label="돌아다니기 시퀀스"
        onRun={run}
        slot="walk"
      />

      <SettingsRow
        label="창 위치"
        hint={
          settings.position
            ? `옮겨 둔 자리(${settings.position.x}, ${settings.position.y})에서 뜹니다. 화면 밖이면 우하단으로 돌아옵니다`
            : '우하단 기본 위치에서 뜹니다. 펫을 끌어 옮기면 그 자리를 기억합니다'
        }
      >
        <button
          className="settings-clear"
          disabled={busy || !settings.position}
          onClick={() => run(() => window.newbie.petResetPosition())}
          type="button"
        >
          기본 위치로
        </button>
      </SettingsRow>

      {error && <div className="settings-warning">{error}</div>}
    </section>
  );
}

function SettingsRow({
  children,
  hint,
  label,
}: {
  children: React.ReactNode;
  hint?: string;
  label: string;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/**
 * 설정값을 불러오고 저장한다.
 *
 * 저장은 입력 칸을 벗어날 때(onBlur)만 한다. 글자마다 저장하면 파일 쓰기가
 * 타자 속도로 일어나고, 이름을 지우는 중간 상태("영" → "")가 그대로 저장된다.
 */
function usePreferences() {
  const [draft, setDraft] = useState<Preferences>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  // 저장할 값이 실제로 바뀌었을 때만 파일을 건드리기 위한 마지막 저장본
  const savedRef = useRef<Preferences>(EMPTY);

  useEffect(() => {
    let alive = true;
    void window.newbie.preferences().then(preferences => {
      if (!alive) return;
      setDraft(preferences);
      savedRef.current = preferences;
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  function setField(key: keyof Preferences, value: string) {
    setDraft(previous => ({ ...previous, [key]: value }));
  }

  function save() {
    if (!loaded) return;
    const next = draft;
    const previous = savedRef.current;
    const changed = (Object.keys(next) as (keyof Preferences)[]).some(
      key => next[key] !== previous[key],
    );
    if (!changed) return;

    savedRef.current = next;
    void window.newbie.savePreferences(next).then(stored => {
      // 저장 쪽에서 다듬은 값(공백 정리·길이 제한)을 화면에 되돌린다
      savedRef.current = stored;
      setDraft(stored);
    });
  }

  return { draft, loaded, save, setField };
}
