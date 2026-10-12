/*
 * 설정창 > 제공자 탭 회귀 테스트.
 *
 * 여기서도 화면 쪽으로 버그가 빠져나간 적이 있다 — 키가 없을 때 입력 칸이
 * 막혀 있어야 하는데 예시 글자가 남아 눌러 보게 됐던 것, 그리고 저장하지 않고
 * 닫을 때 값이 조용히 사라지던 것.
 */
import { setupDom } from './domSetup.ts';

setupDom();

const { afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen, waitFor } = await import(
  '@testing-library/react'
);
const React = (await import('react')).default;

const { SettingsModal } = await import('../app/renderer/src/components/SettingsModal.tsx');

function field(key: string, extra: Record<string, unknown> = {}) {
  return { key, secret: false, value: '', present: false, overriddenByEnv: false, ...extra };
}

function stubBridge(over: Record<string, unknown> = {}) {
  const state = {
    available: true,
    custom: [],
    customPrefix: 'NEWBIE_SECRET_',
    providers: (over.providers as string[]) ?? ['anthropic', 'openai'],
    fields: [
      field('NEWBIE_PROVIDER', { value: 'anthropic', present: true }),
      field('ANTHROPIC_MODEL'),
      field('ANTHROPIC_API_KEY', { secret: true }),
      ...over.extraFields as never[] ?? [],
    ],
  };
  const saveCredentials = mock(() => Promise.resolve(state));
  (globalThis as any).window.newbie = {
    credentials: () => Promise.resolve(state),
    saveCredentials,
    providerModels: () => Promise.resolve({ models: [] }),
    preferences: () => Promise.resolve({ agentName: '', instructions: '', userName: '' }),
    savePreferences: () => Promise.resolve({ agentName: '', instructions: '', userName: '' }),
    setThemeColors: () => {},
    setTitlebarShade: () => {},
    appVersion: () => Promise.resolve('0.5.0'),
  };
  return { saveCredentials };
}

async function openProviderTab() {
  await waitFor(() => expect(screen.getByText('제공자')).toBeTruthy());
  fireEvent.click(screen.getByText('제공자'));
  await waitFor(() => expect(screen.getByText('기본 제공자')).toBeTruthy());
}

afterEach(() => cleanup());

describe('설정창', () => {
  test('좌측 맨 아래에 지금 쓰는 앱 버전을 보인다', async () => {
    stubBridge();

    render(<SettingsModal onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('Newbie v0.5.0')).toBeTruthy());
    // 탭 목록과 같은 좌측 레일 안, 마지막 자리다
    const rail = screen.getByText('Newbie v0.5.0').closest('nav');
    expect(rail?.className).toBe('settings-rail');
    expect(rail?.lastElementChild?.textContent).toBe('Newbie v0.5.0');
  });
});

describe('제공자 탭', () => {
  test('키가 없으면 기본 모델 칸을 막고 예시 글자도 지운다', async () => {
    stubBridge();
    render(<SettingsModal onClose={() => {}} />);
    await openProviderTab();

    const model = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>('.settings-input[type="text"]');
      if (!found) throw new Error('기본 모델 칸 없음');
      return found;
    });
    expect(model.disabled).toBe(true);
    // 흐릿하게라도 글자가 남으면 입력할 수 있는 칸처럼 보인다
    expect(model.placeholder).toBe('');
  });

  test('저장하지 않고 닫으면 물어보고, 저장 안 함을 고르면 닫힌다', async () => {
    stubBridge();
    let closed = false;
    render(<SettingsModal onClose={() => { closed = true; }} />);
    await openProviderTab();

    // 제공자를 바꿔 저장하지 않은 변경을 만든다
    fireEvent.click(screen.getByText('OpenAI'));
    fireEvent.click(screen.getByLabelText('닫기'));

    await waitFor(() =>
      expect(screen.getByText('저장하지 않은 변경이 있습니다. 저장하시겠습니까?')).toBeTruthy(),
    );
    expect(closed).toBe(false);

    fireEvent.click(screen.getByText('저장 안 함'));
    await waitFor(() => expect(closed).toBe(true));
  });

  test('바꾼 게 없으면 묻지 않고 바로 닫힌다', async () => {
    stubBridge();
    let closed = false;
    render(<SettingsModal onClose={() => { closed = true; }} />);
    await openProviderTab();

    fireEvent.click(screen.getByLabelText('닫기'));
    await waitFor(() => expect(closed).toBe(true));
    expect(screen.queryByText('저장하지 않은 변경이 있습니다. 저장하시겠습니까?')).toBeNull();
  });

  test('주소를 저장하기 전에는 로컬 제공자도 조회하지 않고 칸을 막는다', async () => {
    const providerModels = mock(() => Promise.resolve({ models: [] }));
    const state = {
      available: true,
      custom: [],
      customPrefix: 'NEWBIE_SECRET_',
      providers: ['llamacpp'],
      fields: [
        field('NEWBIE_PROVIDER', { value: 'llamacpp', present: true }),
        field('LLAMACPP_MODEL'),
        field('LLAMACPP_BASE_URL'),
      ],
    };
    (globalThis as any).window.newbie = {
      credentials: () => Promise.resolve(state),
      saveCredentials: () => Promise.resolve(state),
      providerModels,
      preferences: () => Promise.resolve({ agentName: '', instructions: '', userName: '' }),
      savePreferences: () => Promise.resolve({ agentName: '', instructions: '', userName: '' }),
      setThemeColors: () => {},
      setTitlebarShade: () => {},
      appVersion: () => Promise.resolve('0.5.0'),
    };

    render(<SettingsModal onClose={() => {}} />);
    await openProviderTab();

    await waitFor(() =>
      expect(screen.getByText('서버 주소를 저장하면 모델을 목록에서 고를 수 있습니다')).toBeTruthy(),
    );
    // 주소를 넣은 적이 없는데 서버를 찔러 보고 실패를 오류로 보여주면 안 된다
    expect(providerModels).not.toHaveBeenCalled();

    const model = document.querySelector<HTMLInputElement>('.settings-input[type="text"]');
    expect(model?.disabled).toBe(true);
    expect(model?.placeholder).toBe('');
  });

  test('탭을 옮길 때도 물어보고, 저장 안 함을 고르면 옮겨간다', async () => {
    stubBridge();
    render(<SettingsModal onClose={() => {}} />);
    await openProviderTab();

    fireEvent.click(screen.getByText('OpenAI'));
    fireEvent.click(screen.getByText('일반'));

    // 탭만 막지 않으면 여기서 값이 조용히 사라진다
    await waitFor(() =>
      expect(screen.getByText('저장하지 않은 변경이 있습니다. 저장하시겠습니까?')).toBeTruthy(),
    );
    expect(screen.getByText('기본 제공자')).toBeTruthy();

    fireEvent.click(screen.getByText('저장 안 함'));
    await waitFor(() => expect(screen.getByText('프로필')).toBeTruthy());
  });

  test('확인창에서 저장을 고르면 저장한 뒤 닫는다', async () => {
    const { saveCredentials } = stubBridge();
    let closed = false;
    render(<SettingsModal onClose={() => { closed = true; }} />);
    await openProviderTab();

    fireEvent.click(screen.getByText('OpenAI'));
    fireEvent.click(screen.getByLabelText('닫기'));
    await waitFor(() => expect(screen.getByText('저장 안 함')).toBeTruthy());
    // 화면에 "저장"이 둘이다 — 탭 하단 버튼과 확인창 버튼. 확인창 쪽을 고른다
    const confirmSave = document.querySelector<HTMLButtonElement>('.confirm-ok');
    if (!confirmSave) throw new Error('확인창의 저장 버튼 없음');
    fireEvent.click(confirmSave);

    await waitFor(() => expect(saveCredentials).toHaveBeenCalled());
    expect(saveCredentials.mock.calls[0][0]).toEqual({ NEWBIE_PROVIDER: 'openai' });
    await waitFor(() => expect(closed).toBe(true));
  });
});

describe('웹 검색 묶음', () => {
  // 설치본에는 .env를 둘 자리가 없어, 설정창에 칸이 없으면 web_search를 켤 방법이 없었다
  test('Tavily 키 칸은 고른 제공자와 무관하게 보이고, 넣은 키를 저장한다', async () => {
    const { saveCredentials } = stubBridge({ extraFields: [field('TAVILY_API_KEY', { secret: true })] });
    render(<SettingsModal onClose={() => {}} />);
    await openProviderTab();

    await waitFor(() => expect(screen.getByText('웹 검색')).toBeTruthy());
    expect(screen.getByText('Tavily API 키')).toBeTruthy();
    const input = document.querySelector<HTMLInputElement>('.settings-input[type="password"][placeholder="tvly-..."]');
    expect(input).toBeTruthy();

    fireEvent.change(input!, { target: { value: 'tvly-test-key' } });
    fireEvent.click(screen.getByText('저장'));
    await waitFor(() => expect(saveCredentials).toHaveBeenCalledWith({ TAVILY_API_KEY: 'tvly-test-key' }));
  });
});

describe('샘플링 묶음', () => {
  test('고른 제공자와 무관하게 보이고, 비우면 기본값이라고 안내한다', async () => {
    stubBridge({ extraFields: [field('NEWBIE_TEMPERATURE'), field('NEWBIE_TOP_K')] });
    render(<SettingsModal onClose={() => {}} />);
    await openProviderTab();

    await waitFor(() => expect(screen.getByText('샘플링')).toBeTruthy());
    expect(screen.getByText('temperature')).toBeTruthy();
    expect(screen.getByText(/비우면 모델 기본값/)).toBeTruthy();
    expect(document.querySelector('.settings-input[placeholder="예: 20"]')).toBeTruthy();
  });
});

describe('vLLM 제공자', () => {
  function stubVllm(over: Record<string, unknown> = {}) {
    return stubBridge({
      providers: ['anthropic', 'vllm'],
      extraFields: [
        field('VLLM_MODEL'),
        field('VLLM_BASE_URL', over.baseUrl ? { value: String(over.baseUrl), present: true } : {}),
        field('VLLM_API_KEY', { secret: true, present: Boolean(over.key) }),
      ],
    });
  }

  async function openVllm() {
    await waitFor(() => expect(screen.getByText('제공자')).toBeTruthy());
    fireEvent.click(screen.getByText('제공자'));
    await waitFor(() => expect(screen.getByText('vLLM')).toBeTruthy());
    fireEvent.click(screen.getByText('vLLM'));
  }

  test('주소와 키를 함께 보여준다', async () => {
    stubVllm();
    render(<SettingsModal onClose={() => {}} />);
    await openVllm();

    // 다른 제공자는 한 줄이지만 vLLM만 둘을 받는다
    await waitFor(() => expect(screen.getByText('vLLM 주소')).toBeTruthy());
    expect(screen.getByText('vLLM API 키')).toBeTruthy();
  });

  test('주소만 넣으면 모델 칸이 아직 막혀 있다', async () => {
    stubVllm({ baseUrl: 'http://192.168.0.10:8000/v1' });
    render(<SettingsModal onClose={() => {}} />);
    await openVllm();

    // 키 없이 목록을 물어보면 사용자가 시킨 적 없는 401이 오류로 뜬다
    await waitFor(() => expect(screen.getByText('vLLM 주소')).toBeTruthy());
    const model = document.querySelector<HTMLInputElement>('.settings-input[type="text"]');
    expect(model?.disabled).toBe(true);
  });

  test('주소 안내는 /v1을 포함하라고 말한다', async () => {
    stubVllm();
    render(<SettingsModal onClose={() => {}} />);
    await openVllm();

    // llama.cpp는 반대로 /v1을 빼라고 한다 — 둘을 헷갈리면 404가 난다
    await waitFor(() => expect(screen.getByText('끝에 /v1까지 포함해 주세요')).toBeTruthy());
  });
});
