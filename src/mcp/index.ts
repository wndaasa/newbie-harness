// 설정에 적힌 MCP 서버들을 연결하고, 서버가 알려준 도구를 도구 레지스트리에 합류시킨다.
//
// 자체 도구는 모듈을 import하는 순간 등록되지만 MCP 도구는 연결이 끝나야 알 수 있어,
// 연결·해제 시점에 레지스트리에서 붙였다 뗀다.

import { registerTool, unregisterToolSource } from '../tools/registry.ts';
import { connectMcpServer, McpAuthRequiredError } from './client.ts';
import { getMcpConfigPath, readMcpConfig } from './config.ts';
import { buildMcpToolDef } from './toolBridge.ts';
import { clearMcpCredentials } from './oauth.ts';
import type { ConnectOptions, McpConnection } from './client.ts';
import type { McpServerConfig } from './config.ts';

export { getMcpConfigPath } from './config.ts';
export { setBrowserOpener as setMcpBrowserOpener } from './oauth.ts';

export type McpServerState = 'connected' | 'disabled' | 'failed' | 'needs-auth';

/**
 * 이 크기를 넘는 서버는 도구 정의를 매 요청에 싣지 않고 지연 로딩으로 돌린다.
 *
 * 자체 도구 정의를 전부 합쳐도 7,000자 안팎이다. 그 두 배를 넘어가면 한 서버가
 * 요청의 대부분을 차지한다는 뜻이라 기준으로 삼았다. Notion은 112,000자로
 * 한참 넘고, 도구 서너 개짜리 작은 서버는 걸리지 않는다.
 */
const DEFER_THRESHOLD_CHARS = 15_000;

function totalDefinitionChars(defs: { description: string; parameters: unknown }[]): number {
  return defs.reduce(
    (sum, def) => sum + def.description.length + JSON.stringify(def.parameters).length,
    0,
  );
}

export type McpServerStatus = {
  /** 도구가 무거워 지연 로딩으로 돌린 서버인지 */
  deferred?: boolean;
  error?: string;
  name: string;
  state: McpServerState;
  toolCount: number;
  /** 사용자에게 보여줄 연결 대상 (명령 또는 URL) */
  target: string;
  type: McpServerConfig['type'];
};

const connections = new Map<string, McpConnection>();
let statuses: McpServerStatus[] = [];
let problems: string[] = [];

export function getMcpStatuses(): McpServerStatus[] {
  return statuses;
}

export function getMcpProblems(): string[] {
  return problems;
}

/**
 * 설정의 모든 서버에 연결하고 도구를 등록한다. 이미 연결돼 있으면 먼저 정리해
 * 재연결로 동작한다. 한 서버가 실패해도 나머지는 계속 붙인다.
 *
 * 브라우저 승인은 시작하지 않는다 — 앱을 켜기만 해도 승인 창이 뜨는 것을 막기
 * 위함이고, 승인이 필요한 서버는 needs-auth로 표시된다.
 */
export async function connectMcpServers(): Promise<McpServerStatus[]> {
  await disconnectMcpServers();

  const config = readMcpConfig();
  problems = config.problems;

  statuses = await Promise.all(
    config.servers.map(server => connectOne(server, { interactive: false })),
  );
  return statuses;
}

/** 서버 하나만 다시 연결 (/mcp reconnect) */
export async function reconnectMcpServer(name: string): Promise<McpServerStatus | undefined> {
  return connectByName(name, { interactive: false });
}

/**
 * 저장된 OAuth 자격증명을 지우고 브라우저 승인부터 다시 받는다 (/mcp auth).
 * 사용자가 직접 요청한 경로이므로 이때만 승인 창을 띄운다.
 */
export async function reauthMcpServer(name: string): Promise<McpServerStatus | undefined> {
  clearMcpCredentials(name);
  return connectByName(name, { interactive: true });
}

async function connectByName(
  name: string,
  options: ConnectOptions,
): Promise<McpServerStatus | undefined> {
  const config = readMcpConfig();
  problems = config.problems;

  const server = config.servers.find(entry => entry.name === name);
  if (!server) return undefined;

  await closeConnection(name);
  const status = await connectOne(server, options);
  statuses = [...statuses.filter(entry => entry.name !== name), status];
  return status;
}

export async function disconnectMcpServers(): Promise<void> {
  await Promise.all([...connections.keys()].map(closeConnection));
  statuses = [];
}

async function connectOne(
  server: McpServerConfig,
  options: ConnectOptions,
): Promise<McpServerStatus> {
  const target = server.type === 'stdio' ? server.command : server.url;
  const base = { name: server.name, target, type: server.type };

  if (!server.enabled) {
    return { ...base, state: 'disabled', toolCount: 0 };
  }

  try {
    const connection = await connectMcpServer(server, options);
    connections.set(server.name, connection);

    const defs = connection.tools.map(tool =>
      buildMcpToolDef(server.name, connection.client, tool),
    );
    // 도구 정의가 작은 서버까지 검색·불러오기 왕복을 태우면 손해다. 이 서버가
    // 요청에 얹는 무게를 재서 무거울 때만 지연 로딩으로 돌린다
    const deferred = totalDefinitionChars(defs) > DEFER_THRESHOLD_CHARS;
    for (const def of defs) {
      registerTool(deferred ? { ...def, deferred: true } : def);
    }

    return {
      ...base,
      deferred,
      state: 'connected',
      toolCount: defs.length,
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
      state: error instanceof McpAuthRequiredError ? 'needs-auth' : 'failed',
      toolCount: 0,
    };
  }
}

async function closeConnection(name: string): Promise<void> {
  unregisterToolSource(name);

  const connection = connections.get(name);
  if (!connection) return;

  connections.delete(name);
  try {
    await connection.close();
  } catch {
    // 이미 끊긴 서버를 닫는 실패는 무시 — 도구는 위에서 이미 걷어냈다
  }
}

export function formatMcpStatus(): string {
  const lines: string[] = ['MCP 서버'];

  if (statuses.length === 0) {
    lines.push(`  설정된 서버가 없습니다. ${getMcpConfigPath()} 에 mcpServers를 추가하세요.`);
  }

  for (const status of statuses) {
    const label =
      status.state === 'connected'
        ? `연결됨 (도구 ${status.toolCount}개${status.deferred ? ', 필요할 때 불러옴' : ''})`
        : status.state === 'disabled'
          ? '사용 안 함'
          : status.state === 'needs-auth'
            ? `인증 필요 — /mcp auth ${status.name}`
            : `실패: ${status.error ?? '알 수 없는 오류'}`;
    lines.push(`  ${status.name.padEnd(16, ' ')}${status.type.padEnd(6, ' ')}${label}`);
    lines.push(`  ${' '.repeat(16)}${status.target}`);
  }

  if (problems.length > 0) {
    lines.push('', '설정 문제', ...problems.map(problem => `  ${problem}`));
  }

  return lines.join('\n');
}
