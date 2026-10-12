// MCP OAuth 자격증명 저장소 회귀 테스트.
//
// 액세스·리프레시 토큰은 기본 구현에서 ~/.newbie/mcp-auth/<서버>.json에 평문으로
// 남는다. 파일 권한(0o600)은 Windows에서 무시되므로, Electron에서는 암호화
// 저장소를 주입해 그 파일을 아예 만들지 않는다(app/main/credentials.ts).
// 여기서 고정하는 것은 "주입한 저장소로 실제로 갈아끼워지는가" 하나다 —
// 주입이 조용히 무시되면 토큰이 평문으로 계속 새는데 화면으로는 알 길이 없다.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearMcpCredentials,
  fileCredentialVault,
  hasMcpCredentials,
  McpOAuthClientProvider,
  setBrowserOpener,
  setMcpCredentialVault,
  startLoopbackReceiver,
} from '../src/mcp/oauth.ts';
import type { McpCredentialVault } from '../src/mcp/oauth.ts';

function fakeVault() {
  const store = new Map<string, string>();
  const vault: McpCredentialVault = {
    read: name => store.get(name),
    write: (name, json) => void store.set(name, json),
    remove: name => void store.delete(name),
    has: name => store.has(name),
  };
  setMcpCredentialVault(vault);
  return store;
}

// 다른 테스트가 실제 홈 디렉터리를 건드리지 않도록 기본값으로 되돌린다.
// 브라우저 오프너는 기본값(rundll32로 실제 브라우저 실행)으로 두면 다른
// 테스트가 창을 띄울 수 있어, 아무것도 하지 않는 것으로 바꿔 둔다
afterEach(() => {
  setMcpCredentialVault(fileCredentialVault);
  setBrowserOpener(() => {});
});

describe('MCP OAuth 저장소 주입', () => {
  test('토큰은 주입한 저장소로만 나간다', () => {
    const store = fakeVault();
    const provider = new McpOAuthClientProvider('notion', 'http://127.0.0.1:1/callback');

    provider.saveTokens({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer' });

    expect(JSON.parse(store.get('notion') ?? '{}').tokens.access_token).toBe('at-1');
    expect(provider.tokens()?.refresh_token).toBe('rt-1');
  });

  test('code verifier를 저장해도 토큰이 지워지지 않는다', () => {
    fakeVault();
    const provider = new McpOAuthClientProvider('notion', 'http://127.0.0.1:1/callback');

    provider.saveTokens({ access_token: 'at-1', token_type: 'bearer' });
    provider.saveCodeVerifier('verifier-1');

    // 갱신 때마다 한 항목씩 쓰므로 통째로 덮어쓰면 승인이 날아간다
    expect(provider.tokens()?.access_token).toBe('at-1');
    expect(provider.codeVerifier()).toBe('verifier-1');
  });

  test('has·clear도 같은 저장소를 본다', () => {
    const store = fakeVault();
    const provider = new McpOAuthClientProvider('notion', 'http://127.0.0.1:1/callback');

    expect(hasMcpCredentials('notion')).toBe(false);
    provider.saveTokens({ access_token: 'at-1', token_type: 'bearer' });
    expect(hasMcpCredentials('notion')).toBe(true);

    // 재인증(MCP 탭의 인증 버튼)이 남은 승인을 실제로 지워야 한다
    clearMcpCredentials('notion');
    expect(store.has('notion')).toBe(false);
    expect(hasMcpCredentials('notion')).toBe(false);
  });

  test('저장된 값이 깨져 있으면 미인증으로 본다', () => {
    const store = fakeVault();
    store.set('notion', '{ 깨진 값');

    // 앱이 터지는 것보다 다시 인증받는 편이 낫다
    const provider = new McpOAuthClientProvider('notion', 'http://127.0.0.1:1/callback');
    expect(provider.tokens()).toBeUndefined();
  });
});

describe('자동 연결의 승인 창', () => {
  function recordOpener() {
    const opened: string[] = [];
    setBrowserOpener(url => void opened.push(url));
    return opened;
  }

  test('자동 연결이면 브라우저를 열지 않는다', async () => {
    fakeVault();
    const opened = recordOpener();
    const provider = new McpOAuthClientProvider('notion', 'http://127.0.0.1:1/callback', false);

    await provider.redirectToAuthorization(new URL('https://mcp.notion.com/authorize'));

    // 만료된 승인이 남아 있으면 SDK가 401 직후 이 메서드부터 부른다. 여기서
    // 막지 않으면 앱을 켜기만 해도 동의 화면이 뜨고, 자동 연결은 코드를
    // 기다리지 않고 수신기를 닫으므로 승인해도 빈 페이지만 남는다
    expect(opened).toEqual([]);
  });

  test('사용자가 요청한 인증이면 연다', async () => {
    fakeVault();
    const opened = recordOpener();
    const provider = new McpOAuthClientProvider('notion', 'http://127.0.0.1:1/callback', true);

    await provider.redirectToAuthorization(new URL('https://mcp.notion.com/authorize'));

    expect(opened).toEqual(['https://mcp.notion.com/authorize']);
  });
});

describe('승인 경로 검증', () => {
  test('http·https가 아닌 승인 주소는 열지 않는다', async () => {
    // 주소는 원격 서버의 메타데이터에서 온다. OS 핸들러로 넘기면 브라우저가 아닌 것이 실행될 수 있다
    fakeVault();
    const opened: string[] = [];
    setBrowserOpener(url => void opened.push(url));
    const provider = new McpOAuthClientProvider('notion', 'http://127.0.0.1:1/callback', true);

    await expect(provider.redirectToAuthorization(new URL('file:///C:/Windows/System32/calc.exe'))).rejects.toThrow();
    expect(opened).toEqual([]);
  });

  test('state가 맞지 않는 콜백은 code로 받지 않는다', async () => {
    const receiver = await startLoopbackReceiver();
    try {
      const forged = await fetch(`${receiver.redirectUrl}?code=forged&state=wrong`);
      expect(forged.status).toBe(400);

      const real = await fetch(`${receiver.redirectUrl}?code=real&state=${receiver.state}`);
      expect(real.status).toBe(200);
      expect(await receiver.waitForCode()).toBe('real');
    } finally {
      receiver.close();
    }
  });

  test('승인 요청에 수신기의 state를 싣는다', () => {
    const provider = new McpOAuthClientProvider('notion', 'http://127.0.0.1:1/callback', true, 'abc');
    expect(provider.state()).toBe('abc');
  });
});
