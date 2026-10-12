// MCP 서버 설정 파싱 회귀 테스트.
//
// mcp.json은 사용자가 손으로 쓰는 파일이라 형식이 어긋난 항목이 섞이기 쉽다.
// 잘못된 항목 하나 때문에 나머지 서버까지 연결되지 않으면 원인을 찾기 어려우므로,
// 문제 항목만 problems로 빠지고 나머지는 살아남는지 고정한다.
// 서버 이름은 도구 이름(mcp__<서버>__<도구>)에 그대로 들어가므로 문자 제한도 함께 본다.

import { afterEach, describe, expect, test } from 'bun:test';
import { parseMcpConfig } from '../src/mcp/config.ts';

describe('mcp.json 파싱', () => {
  test('url만 있으면 http, command만 있으면 stdio로 판단한다', () => {
    const { problems, servers } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          local: { command: 'npx', args: ['-y', 'server'] },
          notion: { url: 'https://mcp.notion.com/mcp' },
        },
      }),
    );

    expect(problems).toEqual([]);
    expect(servers.map(server => [server.name, server.type])).toEqual([
      ['local', 'stdio'],
      ['notion', 'http'],
    ]);
  });

  test('type을 명시하면 그 값을 따른다', () => {
    const { servers } = parseMcpConfig(
      JSON.stringify({ mcpServers: { remote: { type: 'sse', url: 'https://example.com/sse' } } }),
    );

    expect(servers[0].type).toBe('sse');
  });

  test('enabled false와 disabled true 모두 연결 대상에서 뺀다', () => {
    const { servers } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          off: { command: 'a', enabled: false },
          skipped: { command: 'b', disabled: true },
          on: { command: 'c' },
        },
      }),
    );

    expect(servers.map(server => [server.name, server.enabled])).toEqual([
      ['off', false],
      ['skipped', false],
      ['on', true],
    ]);
  });

  test('잘못된 항목만 problems로 빠지고 나머지 서버는 살아남는다', () => {
    const { problems, servers } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          empty: {},
          'bad name': { command: 'a' },
          notAnObject: 'nope',
          good: { command: 'npx' },
        },
      }),
    );

    expect(servers.map(server => server.name)).toEqual(['good']);
    expect(problems).toHaveLength(3);
  });

  test('mcpServers가 없거나 JSON이 깨지면 서버 없이 사유를 남긴다', () => {
    expect(parseMcpConfig('{}').problems).toHaveLength(1);
    expect(parseMcpConfig('{ not json').servers).toEqual([]);
    expect(parseMcpConfig('{ not json').problems).toHaveLength(1);
  });
});

describe('환경 변수 치환', () => {
  afterEach(() => {
    delete process.env.NEWBIE_TEST_MCP_TOKEN;
  });

  test('url·env·headers의 ${VAR}를 환경 변수로 바꾼다', () => {
    process.env.NEWBIE_TEST_MCP_TOKEN = 'secret-value';

    const { servers } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          remote: {
            headers: { Authorization: 'Bearer ${NEWBIE_TEST_MCP_TOKEN}' },
            url: 'https://example.com/mcp',
          },
        },
      }),
    );

    const server = servers[0];
    expect(server.type === 'http' && server.headers.Authorization).toBe('Bearer secret-value');
  });

  test('값이 없는 변수는 빈 문자열이 된다', () => {
    const { servers } = parseMcpConfig(
      JSON.stringify({
        mcpServers: { local: { command: 'npx', env: { TOKEN: '${NEWBIE_TEST_MCP_TOKEN}' } } },
      }),
    );

    const server = servers[0];
    expect(server.type === 'stdio' && server.env.TOKEN).toBe('');
  });
});
