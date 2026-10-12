// Streamable HTTP MCP 서버용 OAuth 2.0 클라이언트 저장소.
//
// PKCE 생성, 인증 서버 탐색, Dynamic Client Registration, 토큰 교환·갱신은 SDK가
// 처리한다. 여기서 맡는 것은 SDK가 요구하는 저장소(클라이언트 정보·토큰·code
// verifier)와, 브라우저 승인을 받아 authorization code를 회수하는 부분이다.
//
// 호스티드 Notion MCP 서버는 통합 토큰(Bearer)을 받지 않고 OAuth만 지원하므로
// 이 경로가 없으면 붙을 수 없다.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getNewbieHome } from '../memory/globalNewbie.ts';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const AUTH_DIR = 'mcp-auth';
const CALLBACK_PATH = '/callback';
/** 사용자가 브라우저에서 승인을 마칠 때까지 기다리는 시간 */
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;

type StoredCredentials = {
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  tokens?: OAuthTokens;
};

/** 승인 URL을 사용자 브라우저로 여는 함수. Electron에서는 shell.openExternal을 주입함 */
export type BrowserOpener = (url: string) => Promise<void> | void;

let openBrowser: BrowserOpener = openWithOsCommand;

export function setBrowserOpener(opener: BrowserOpener): void {
  openBrowser = opener;
}

/**
 * 서버별 OAuth 자격증명을 담아 두는 곳. 값은 JSON 문자열로 주고받는다.
 *
 * 기본 구현은 ~/.newbie/mcp-auth/<서버>.json 파일이다. 여기에는 액세스·리프레시
 * 토큰이 그대로 들어가는데, 파일 권한(mode 0o600)은 Windows에서 무시되므로
 * Electron에서는 app/main/credentials.ts가 OS 암호화 저장소 구현을 주입한다.
 * 이 모듈이 직접 safeStorage를 부르지 않는 이유는 credentials.ts와 같다 —
 * src/에는 electron import를 두지 않는다(scripts/smoke.ts와 bun test가 깨진다).
 */
export type McpCredentialVault = {
  read(serverName: string): string | undefined;
  write(serverName: string, json: string): void;
  remove(serverName: string): void;
  has(serverName: string): boolean;
};

export const fileCredentialVault: McpCredentialVault = {
  read(serverName) {
    const path = credentialsPath(serverName);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  },
  write(serverName, json) {
    mkdirSync(getMcpAuthDir(), { recursive: true });
    // 액세스·리프레시 토큰이 담기므로 소유자만 읽게 제한 (Windows에서는 무시됨)
    writeFileSync(credentialsPath(serverName), json, { encoding: 'utf8', mode: 0o600 });
  },
  remove(serverName) {
    rmSync(credentialsPath(serverName), { force: true });
  },
  has(serverName) {
    return existsSync(credentialsPath(serverName));
  },
};

let vault: McpCredentialVault = fileCredentialVault;

export function setMcpCredentialVault(next: McpCredentialVault): void {
  vault = next;
}

export function getMcpAuthDir(): string {
  return join(getNewbieHome(), AUTH_DIR);
}

/** 저장된 자격증명 삭제 (재인증용) */
export function clearMcpCredentials(serverName: string): void {
  vault.remove(serverName);
}

export function hasMcpCredentials(serverName: string): boolean {
  return vault.has(serverName);
}

/**
 * 브라우저 승인 후 authorization code를 돌려받는 루프백 수신기.
 *
 * redirect_uri는 Dynamic Client Registration 시점에 이미 확정되어야 하므로,
 * 포트를 먼저 잡아 두고 그 주소로 클라이언트를 등록한다.
 */
export type LoopbackReceiver = {
  close(): void;
  redirectUrl: string;
  /**
   * 승인 요청에 실어 보낼 state. 돌아온 요청의 state가 이것과 다르면 무시한다 —
   * 같은 컴퓨터의 다른 프로세스나 웹 페이지가 루프백 주소로 남의 code를 밀어
   * 넣는 것을 막는다
   */
  state: string;
  waitForCode(): Promise<string>;
};

export async function startLoopbackReceiver(): Promise<LoopbackReceiver> {
  const state = randomBytes(16).toString('hex');
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }

    if (requestUrl.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<meta charset="utf-8"><p>이 앱이 시작한 승인 요청이 아닙니다.</p>');
      return;
    }

    const code = requestUrl.searchParams.get('code');
    const error = requestUrl.searchParams.get('error');

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      code
        ? '<meta charset="utf-8"><p>연결되었습니다. 이 창을 닫고 Newbie로 돌아가세요.</p>'
        : `<meta charset="utf-8"><p>인증에 실패했습니다: ${escapeHtml(error ?? '알 수 없는 오류')}</p>`,
    );

    if (code) resolveCode(code);
    else rejectCode(new Error(`인증이 거부되었습니다: ${error ?? '알 수 없는 오류'}`));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as AddressInfo).port;
  const timeout = setTimeout(() => {
    rejectCode(new Error('브라우저 승인이 제한 시간 안에 끝나지 않았습니다.'));
  }, AUTHORIZE_TIMEOUT_MS);
  // 승인을 기다리는 동안 앱 종료를 막지 않음
  timeout.unref?.();

  return {
    close() {
      clearTimeout(timeout);
      server.close();
    },
    redirectUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    state,
    waitForCode: () => codePromise,
  };
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  private cached: StoredCredentials | undefined;

  constructor(
    private readonly serverName: string,
    private readonly redirect: string,
    /** 사용자가 직접 요청한 승인인지. 자동 연결이면 승인 창을 띄우지 않는다 */
    private readonly interactive = true,
    /** 승인 요청에 실을 state (LoopbackReceiver.state). 비우면 싣지 않는다 */
    private readonly oauthState = '',
  ) {}

  state(): string {
    return this.oauthState;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Newbie',
      client_uri: 'https://github.com/wndaasa/newbie-harness',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [this.redirect],
      response_types: ['code'],
      // 공개 클라이언트 — 시크릿을 배포본에 넣을 수 없으므로 PKCE만으로 인증한다
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.write({ ...this.read(), clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    // 리프레시 토큰은 갱신할 때마다 새로 발급되므로 받은 값을 그대로 덮어써야 한다
    this.write({ ...this.read(), tokens });
  }

  codeVerifier(): string {
    const verifier = this.read().codeVerifier;
    if (!verifier) throw new Error('저장된 code verifier가 없습니다. 다시 인증해주세요.');
    return verifier;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.write({ ...this.read(), codeVerifier });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // SDK는 401을 받으면 client.ts의 interactive 검사에 닿기 전에 이 메서드부터
    // 부른다(auth.js의 auth()가 redirectToAuthorization 후에야 REDIRECT를 반환).
    // 그래서 여기서 막지 않으면 만료된 승인이 남아 있는 사용자는 앱을 켜기만
    // 해도 브라우저에 동의 화면이 뜬다. 게다가 자동 연결은 코드를 기다리지 않고
    // 곧바로 수신기를 닫으므로, 승인을 눌러도 돌아올 곳이 없어 빈 페이지만 남는다.
    // 열지 않고 돌아가면 SDK가 그대로 UnauthorizedError를 내고 needs-auth로 정리된다
    if (!this.interactive) return;
    // 주소는 원격 MCP 서버가 알려준 메타데이터에서 온다. OS 핸들러로 넘기므로
    // file:이나 다른 앱의 스킴이면 브라우저가 아닌 것이 실행될 수 있다
    if (authorizationUrl.protocol !== 'https:' && authorizationUrl.protocol !== 'http:') {
      throw new Error(`승인 주소의 스킴을 열 수 없습니다: ${authorizationUrl.protocol}`);
    }
    await openBrowser(authorizationUrl.toString());
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      this.cached = {};
      clearMcpCredentials(this.serverName);
      return;
    }

    const stored = { ...this.read() };
    if (scope === 'client') delete stored.clientInformation;
    if (scope === 'tokens') delete stored.tokens;
    if (scope === 'verifier') delete stored.codeVerifier;
    this.write(stored);
  }

  private read(): StoredCredentials {
    if (this.cached) return this.cached;

    const raw = vault.read(this.serverName);
    if (raw === undefined) {
      this.cached = {};
      return this.cached;
    }

    try {
      this.cached = JSON.parse(raw) as StoredCredentials;
    } catch {
      // 값이 깨졌으면 다시 인증받는 편이 낫다
      this.cached = {};
    }
    return this.cached;
  }

  private write(credentials: StoredCredentials): void {
    this.cached = credentials;
    vault.write(this.serverName, JSON.stringify(credentials, null, 2));
  }
}

function credentialsPath(serverName: string): string {
  return join(getMcpAuthDir(), `${serverName}.json`);
}

// Electron이 openExternal을 주입하지 않은 경우(CLI 등)의 대체 경로.
// URL은 인자 배열로 넘겨 셸이 &를 명령 구분자로 해석하지 못하게 한다.
function openWithOsCommand(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
