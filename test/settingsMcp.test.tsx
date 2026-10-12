/*
 * 설정창 > MCP 탭 회귀 테스트.
 *
 * 서버 추가는 설정 파일에서 하고 화면은 그 결과만 보여주므로, 여기서 지킬 것은
 * "파일을 열어 주는 길"과 "인증이 필요한 서버를 알아볼 수 있는가" 두 가지다.
 * 비밀값 입력도 이 탭으로 옮겨 왔으므로 함께 확인한다.
 */
import { setupDom } from './domSetup.ts';

setupDom();

const { afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen, waitFor } = await import(
  '@testing-library/react'
);
const React = (await import('react')).default;

const { SettingsModal } = await import('../app/renderer/src/components/SettingsModal.tsx');

type Server = {
  name: string;
  state: 'connected' | 'disabled' | 'failed' | 'needs-auth';
  type: 'http' | 'sse' | 'stdio';
  target: string;
  toolCount: number;
  deferred?: boolean;
  error?: string;
};

function stubBridge(over: { servers?: Server[]; custom?: { name: string; masked: string }[] } = {}) {
  const mcpState = {
    configPath: 'C:\Users\me\.newbie\mcp.json',
    problems: [],
    servers: over.servers ?? [],
  };
  const credentialState = {
    available: true,
    custom: over.custom ?? [],
    customPrefix: 'NEWBIE_SECRET_',
    providers: ['anthropic'],
    fields: [],
  };
  const mcpOpenConfig = mock(() => Promise.resolve({ path: mcpState.configPath }));
  const mcpAuth = mock(() => Promise.resolve(mcpState));
  const mcpReconnect = mock(() => Promise.resolve(mcpState));
  const saveCredentials = mock(() => Promise.resolve(credentialState));
  (globalThis as any).window.newbie = {
    credentials: () => Promise.resolve(credentialState),
    saveCredentials,
    mcpStatus: () => Promise.resolve(mcpState),
    mcpOpenConfig,
    mcpAuth,
    mcpReconnect,
    providerModels: () => Promise.resolve({ models: [] }),
    preferences: () => Promise.resolve({ agentName: '', instructions: '', userName: '' }),
    savePreferences: () => Promise.resolve({ agentName: '', instructions: '', userName: '' }),
    setThemeColors: () => {},
    setTitlebarShade: () => {},
    appVersion: () => Promise.resolve('0.5.0'),
  };
  return { mcpAuth, mcpOpenConfig, mcpReconnect, saveCredentials };
}

async function openMcpTab() {
  await waitFor(() => expect(screen.getByText('MCP')).toBeTruthy());
  fireEvent.click(screen.getByText('MCP'));
  await waitFor(() => expect(screen.getByText('MCP 서버')).toBeTruthy());
}

const NOTION: Server = {
  name: 'notion',
  state: 'needs-auth',
  type: 'http',
  target: 'https://mcp.notion.com/mcp',
  toolCount: 0,
};

afterEach(() => cleanup());

describe('MCP 탭', () => {
  test('서버가 없으면 설정 파일부터 열라고 안내한다', async () => {
    stubBridge();
    render(<SettingsModal onClose={() => {}} />);
    await openMcpTab();

    await waitFor(() =>
      expect(screen.getByText(/등록된 서버가 없습니다/)).toBeTruthy(),
    );
    // 경로를 알려주지 않으면 어디를 고쳐야 할지 알 수 없다
    expect(screen.getByText('C:\Users\me\.newbie\mcp.json')).toBeTruthy();
  });

  test('설정 파일 열기가 main으로 넘어간다', async () => {
    const { mcpOpenConfig } = stubBridge();
    render(<SettingsModal onClose={() => {}} />);
    await openMcpTab();

    fireEvent.click(screen.getByText('설정 파일 열기'));
    await waitFor(() => expect(mcpOpenConfig).toHaveBeenCalled());
  });

  test('인증이 필요한 서버에만 인증 버튼이 붙는다', async () => {
    const { mcpAuth } = stubBridge({
      servers: [
        NOTION,
        { name: 'files', state: 'connected', type: 'stdio', target: 'npx mcp-files', toolCount: 3 },
      ],
    });
    render(<SettingsModal onClose={() => {}} />);
    await openMcpTab();

    await waitFor(() => expect(screen.getByText('notion')).toBeTruthy());
    expect(screen.getByText('인증 필요')).toBeTruthy();
    expect(screen.getByText('연결됨')).toBeTruthy();
    // 연결된 서버까지 인증 버튼이 나오면 눌러서 승인을 날려 버리게 된다
    expect(screen.getAllByText('인증').length).toBe(1);

    fireEvent.click(screen.getByText('인증'));
    await waitFor(() => expect(mcpAuth).toHaveBeenCalledWith('notion'));
  });

  test('인증 필요 서버는 슬래시 명령 안내를 되풀이하지 않는다', async () => {
    stubBridge({
      servers: [{ ...NOTION, error: '인증이 필요합니다. /mcp auth notion 으로 승인해주세요.' }],
    });
    render(<SettingsModal onClose={() => {}} />);
    await openMcpTab();

    // 버튼이 바로 옆에 있는데 명령어를 치라고 하면 같은 말을 두 번 하는 셈이다
    await waitFor(() => expect(screen.getByText('인증')).toBeTruthy());
    expect(screen.queryByText(/\/mcp auth/)).toBeNull();
  });

  test('실패한 서버는 이유를 함께 보여준다', async () => {
    stubBridge({
      servers: [{ ...NOTION, state: 'failed', error: 'ECONNREFUSED 127.0.0.1:3000' }],
    });
    render(<SettingsModal onClose={() => {}} />);
    await openMcpTab();

    await waitFor(() =>
      expect(screen.getByText('ECONNREFUSED 127.0.0.1:3000')).toBeTruthy(),
    );
  });

  test('다시 연결은 서버 이름을 지정해 보낸다', async () => {
    const { mcpReconnect } = stubBridge({ servers: [{ ...NOTION, state: 'connected' }] });
    render(<SettingsModal onClose={() => {}} />);
    await openMcpTab();

    // 위쪽 전체 버튼과 서버별 버튼이 섞이지 않아야 한다
    await waitFor(() => expect(screen.getAllByText('다시 연결').length).toBe(2));
    const buttons = screen.getAllByText('다시 연결');
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(mcpReconnect).toHaveBeenCalledWith('notion'));
  });

  test('MCP 비밀값은 접두사가 붙은 이름으로 저장된다', async () => {
    const { saveCredentials } = stubBridge();
    render(<SettingsModal onClose={() => {}} />);
    await openMcpTab();

    await waitFor(() => expect(screen.getByPlaceholderText('NOTION_TOKEN')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('NOTION_TOKEN'), {
      target: { value: 'notion token' },
    });
    fireEvent.change(screen.getByPlaceholderText('값'), { target: { value: 'secret-1' } });
    fireEvent.click(screen.getByText('추가'));

    await waitFor(() => expect(saveCredentials).toHaveBeenCalled());
    // 소문자·공백은 환경 변수로 쓸 수 있는 형태로 다듬고 접두사를 강제한다
    expect(saveCredentials.mock.calls[0][0]).toEqual({
      NEWBIE_SECRET_NOTION_TOKEN: 'secret-1',
    });
  });

  test('저장된 비밀값은 붙여넣을 문자열로 보여준다', async () => {
    stubBridge({ custom: [{ name: 'NEWBIE_SECRET_NOTION_TOKEN', masked: 'tok••••••1234' }] });
    render(<SettingsModal onClose={() => {}} />);
    await openMcpTab();

    // 이름이 아니라 설정 파일에 그대로 넣을 형태를 보여줘야 한다
    await waitFor(() =>
      expect(screen.getByText('${NEWBIE_SECRET_NOTION_TOKEN}')).toBeTruthy(),
    );
    expect(screen.getByText('tok••••••1234')).toBeTruthy();
  });
});
