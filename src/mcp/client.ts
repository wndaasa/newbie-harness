// MCP 서버 한 대에 대한 연결.
//
// stdio는 서버 프로세스를 직접 띄우고, http는 Streamable HTTP로 붙는다. 호스티드
// 서버가 Streamable HTTP를 받지 않으면 같은 주소의 SSE 엔드포인트로 한 번 더
// 시도한다 (Notion 문서가 안내하는 순서).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { APP_VERSION } from '../config.ts';
import { McpOAuthClientProvider, hasMcpCredentials, startLoopbackReceiver } from './oauth.ts';
import type { LoopbackReceiver } from './oauth.ts';
import type { McpServerConfig } from './config.ts';
import type { McpToolInfo } from './toolBridge.ts';
import { tieProcessToAppLifetime } from '../utils/windowsJob.ts';
import { withoutStoredSecrets } from '../utils/secretEnv.ts';

const CLIENT_INFO = { name: 'newbie-harness', version: APP_VERSION };

export type McpConnection = {
  client: Client;
  close(): Promise<void>;
  tools: McpToolInfo[];
};

/**
 * 브라우저 승인이 필요한 상태.
 *
 * 앱을 켜기만 해도 승인 창이 뜨고 사용자가 처리할 때까지 연결이 매달려 있으면
 * 곤란하므로, 자동 연결에서는 승인을 시작하지 않고 이 오류로 알린다.
 */
export class McpAuthRequiredError extends Error {
  constructor(serverName: string) {
    super(`인증이 필요합니다. /mcp auth ${serverName} 으로 승인해주세요.`);
    this.name = 'McpAuthRequiredError';
  }
}

export type ConnectOptions = {
  /** true일 때만 브라우저 승인을 시작하고 authorization code를 기다림 */
  interactive: boolean;
};

export async function connectMcpServer(
  config: McpServerConfig,
  options: ConnectOptions,
): Promise<McpConnection> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  if (config.type === 'stdio') {
    const transport = createStdioTransport(config);
    await client.connect(transport);
    // stdio 서버는 자식 프로세스다. 앱이 크래시해도 남지 않게 수명을 묶는다
    tieProcessToAppLifetime(transport.pid);
  } else {
    await connectHttp(client, config, options);
  }

  const listed = await client.listTools();
  return {
    client,
    close: () => client.close(),
    tools: (listed.tools ?? []) as McpToolInfo[],
  };
}

function createStdioTransport(config: Extract<McpServerConfig, { type: 'stdio' }>): StdioClientTransport {
  return new StdioClientTransport({
    args: config.args,
    command: config.command,
    cwd: config.cwd,
    // 앱이 저장해 둔 제공자 API 키는 물려주지 않는다. 서버에 필요한 값은
    // mcp.json의 env에 적으면(${VAR} 치환 포함) 그대로 넘어간다
    env: { ...(withoutStoredSecrets() as Record<string, string>), ...config.env },
    // 서버 stderr가 앱 콘솔을 뒤덮지 않게 파이프로 받아 흘려보낸다
    stderr: 'pipe',
  });
}

async function connectHttp(
  client: Client,
  config: Extract<McpServerConfig, { type: 'http' | 'sse' }>,
  options: ConnectOptions,
): Promise<void> {
  // 저장된 자격증명이 없으면 승인 없이는 어차피 붙을 수 없다. 자동 연결이라면
  // 브라우저를 띄우지 않고 바로 알린다
  if (!options.interactive && !hasMcpCredentials(config.name)) {
    throw new McpAuthRequiredError(config.name);
  }

  const url = new URL(config.url);
  const receiver = await startLoopbackReceiver();
  const authProvider = new McpOAuthClientProvider(
    config.name,
    receiver.redirectUrl,
    options.interactive,
    receiver.state,
  );

  try {
    await connectWithAuth(
      client,
      forceSse => createHttpTransport(config, url, authProvider, forceSse),
      receiver,
      config.name,
      options,
    );
  } finally {
    receiver.close();
  }
}

function createHttpTransport(
  config: Extract<McpServerConfig, { type: 'http' | 'sse' }>,
  url: URL,
  authProvider: McpOAuthClientProvider,
  forceSse = false,
) {
  const options = {
    authProvider,
    requestInit: {
      headers: { 'user-agent': `Newbie-MCP-Client/${APP_VERSION}`, ...config.headers },
    },
  };
  return config.type === 'sse' || forceSse
    ? new SSEClientTransport(url, options)
    : new StreamableHTTPClientTransport(url, options);
}

/**
 * 인증이 필요하면 SDK가 브라우저 승인 URL을 열고 UnauthorizedError를 던진다.
 * 그때 루프백으로 돌아온 authorization code를 넘겨 토큰을 받은 뒤, 새 transport로
 * 다시 붙는다 (승인 과정에서 이미 끊긴 transport는 재사용할 수 없다).
 */
async function connectWithAuth(
  client: Client,
  createTransport: (forceSse?: boolean) => StreamableHTTPClientTransport | SSEClientTransport,
  receiver: LoopbackReceiver,
  serverName: string,
  options: ConnectOptions,
): Promise<void> {
  const transport = createTransport();

  try {
    await client.connect(transport);
    return;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      // Streamable HTTP를 받지 않는 서버가 있어 같은 주소의 SSE로 한 번 더 시도한다
      if (transport instanceof StreamableHTTPClientTransport) {
        await client.connect(createTransport(true));
        return;
      }
      throw error;
    }

    // 저장된 토큰이 있어도 리프레시가 만료되면 여기로 온다 — 자동 연결이면 멈춘다
    if (!options.interactive) throw new McpAuthRequiredError(serverName);

    const code = await receiver.waitForCode();
    await transport.finishAuth(code);
  }

  await client.connect(createTransport());
}
