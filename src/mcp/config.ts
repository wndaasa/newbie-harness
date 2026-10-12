// MCP 서버 설정 (~/.newbie/mcp.json).
//
// 형식은 다른 MCP 클라이언트와 같은 mcpServers 맵을 따른다. 사용자가 다른 도구에서
// 쓰던 설정을 그대로 붙여넣을 수 있게 하기 위함이다.
//
//   {
//     "mcpServers": {
//       "notion":     { "type": "http", "url": "https://mcp.notion.com/mcp" },
//       "filesystem": { "command": "npx", "args": ["-y", "@x/server"], "env": {} }
//     }
//   }

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getNewbieHome } from '../memory/globalNewbie.ts';

const CONFIG_FILE = 'mcp.json';

/** 도구 이름(mcp__<server>__<tool>)에 그대로 들어가므로 프로바이더가 받는 문자만 허용 */
const SERVER_NAME = /^[a-zA-Z0-9-]+$/;

export type McpStdioServerConfig = {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
};

export type McpHttpServerConfig = {
  /** http는 Streamable HTTP로 붙고 실패하면 SSE로 한 번 더 시도함 */
  type: 'http' | 'sse';
  url: string;
  headers: Record<string, string>;
};

export type McpServerConfig = { enabled: boolean; name: string } & (
  | McpHttpServerConfig
  | McpStdioServerConfig
);

export type McpConfigResult = {
  /** 설정 파일이 없으면 problems 없이 빈 목록 */
  problems: string[];
  servers: McpServerConfig[];
};

export function getMcpConfigPath(): string {
  return join(getNewbieHome(), CONFIG_FILE);
}

export function readMcpConfig(configPath = getMcpConfigPath()): McpConfigResult {
  if (!existsSync(configPath)) return { problems: [], servers: [] };

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    return { problems: [`설정 파일을 읽을 수 없습니다: ${String(error)}`], servers: [] };
  }

  return parseMcpConfig(raw);
}

export function parseMcpConfig(raw: string): McpConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { problems: [`JSON 형식이 잘못되었습니다: ${String(error)}`], servers: [] };
  }

  const root = asRecord(parsed);
  const entries = asRecord(root?.mcpServers);
  if (!entries) {
    return { problems: ['mcpServers 객체가 없습니다.'], servers: [] };
  }

  const problems: string[] = [];
  const servers: McpServerConfig[] = [];

  for (const [name, value] of Object.entries(entries)) {
    if (!SERVER_NAME.test(name)) {
      problems.push(`"${name}": 서버 이름은 영문·숫자·하이픈만 쓸 수 있습니다.`);
      continue;
    }

    const entry = asRecord(value);
    if (!entry) {
      problems.push(`"${name}": 설정이 객체가 아닙니다.`);
      continue;
    }

    try {
      servers.push(buildServerConfig(name, entry));
    } catch (error) {
      problems.push(`"${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { problems, servers };
}

function buildServerConfig(name: string, entry: Record<string, unknown>): McpServerConfig {
  // enabled를 생략하면 연결 대상. disabled: true 표기도 함께 받아준다
  const enabled = entry.enabled === undefined ? entry.disabled !== true : entry.enabled === true;
  const declaredType = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined;
  const url = typeof entry.url === 'string' ? expandEnv(entry.url) : '';
  const command = typeof entry.command === 'string' ? expandEnv(entry.command) : '';

  // type을 적지 않아도 url/command 중 무엇을 줬는지로 전송 방식을 판단한다
  const type = declaredType ?? (url ? 'http' : command ? 'stdio' : undefined);

  if (type === 'http' || type === 'sse') {
    if (!url) throw new Error('url이 필요합니다.');
    return {
      enabled,
      headers: toStringMap(entry.headers),
      name,
      type,
      url,
    };
  }

  if (type === 'stdio') {
    if (!command) throw new Error('command가 필요합니다.');
    return {
      args: toStringArray(entry.args),
      command,
      cwd: typeof entry.cwd === 'string' ? expandEnv(entry.cwd) : undefined,
      enabled,
      env: toStringMap(entry.env),
      name,
      type: 'stdio',
    };
  }

  throw new Error('url 또는 command 중 하나가 필요합니다.');
}

// 토큰을 설정 파일에 그대로 적지 않아도 되게 ${VAR}를 환경 변수로 치환한다.
// 값이 없으면 빈 문자열이 되어 연결 단계에서 인증 오류로 드러난다.
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) =>
    process.env[name] ?? '',
  );
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map(expandEnv);
}

function toStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') result[key] = expandEnv(item);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
