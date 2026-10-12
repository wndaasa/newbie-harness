/*
 * 컨텍스트 구성별 측정의 제공자 분기 회귀 테스트.
 *
 * 측정은 조합을 바꿔 가며 네 번 재고 차분으로 쪼갠다. 제공자마다 세는
 * 엔드포인트와 본문 형식이 다르므로, 실제로 어디에 무엇을 보냈는지와 차분이
 * 맞게 나오는지를 fetch를 갈아끼워 확인한다. 캐시는 NEWBIE_HOME을 임시
 * 폴더로 돌려 테스트끼리 섞이지 않게 한다.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureBreakdown, supportsBreakdown } from '../src/providers/contextBreakdown.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let home = '';

type Sent = { url: string; body: any; headers: Record<string, string> };

/** 요청을 모두 기록하고, url·body를 보고 응답을 정하는 가짜 fetch */
function stubFetch(answer: (sent: Sent) => unknown): Sent[] {
  const calls: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const sent = {
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
      url: String(url),
    };
    calls.push(sent);
    return Response.json(answer(sent));
  }) as never;
  return calls;
}

const SYSTEM = 'S'.repeat(40);
const BUILTIN = { name: 'read_file', description: 'd', input_schema: {} };
const MCP = { name: 'mcp__notion__search', description: 'd', input_schema: {} };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'newbie-breakdown-'));
  process.env.NEWBIE_HOME = home;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  rmSync(home, { force: true, recursive: true });
});

describe('구성별 측정 제공자 분기', () => {
  test('anthropic·vllm·llamacpp만 지원한다', () => {
    expect(supportsBreakdown('anthropic')).toBe(true);
    expect(supportsBreakdown('vllm')).toBe(true);
    expect(supportsBreakdown('llamacpp')).toBe(true);
    expect(supportsBreakdown('openai')).toBe(false);
    expect(supportsBreakdown('ollama')).toBe(false);
    expect(supportsBreakdown('lmstudio')).toBe(false);
  });

  test('vLLM은 /tokenize에 messages와 tools를 실어 보내고 차분으로 쪼갠다', async () => {
    process.env.VLLM_BASE_URL = 'http://server:8000/v1';
    process.env.VLLM_API_KEY = 'k';
    const calls = stubFetch(({ body }) => {
      // 기본 10, 시스템 있으면 +100, 도구 하나당 +50 으로 센다고 치자
      const hasSystem = body.messages.some((m: any) => m.role === 'system');
      const tools = body.tools?.length ?? 0;
      return { count: 10 + (hasSystem ? 100 : 0) + tools * 50, max_model_len: 40_960, tokens: [] };
    });

    const parts = await measureBreakdown({
      model: 'qwen3-8b-awq',
      provider: 'vllm',
      systemPrompt: SYSTEM,
      tools: [BUILTIN, MCP],
    });

    expect(parts).toEqual({ mcpTools: 50, system: 100, tools: 50 });
    // /v1 밖의 /tokenize로 간다. /v1/tokenize는 404다
    expect(calls.every(call => call.url === 'http://server:8000/tokenize')).toBe(true);
    expect(calls[0].headers.authorization).toBe('Bearer k');
    const withAll = calls.find(call => call.body.tools?.length === 2)!;
    expect(withAll.body.messages[0]).toEqual({ role: 'system', content: SYSTEM });
    expect(withAll.body.add_generation_prompt).toBe(true);
    expect(withAll.body.model).toBe('qwen3-8b-awq');
  });

  test('llama.cpp는 /apply-template으로 프롬프트를 받아 /tokenize로 센다', async () => {
    process.env.LLAMACPP_BASE_URL = 'http://localhost:8080/v1';
    const calls = stubFetch(({ url, body }) => {
      if (url.endsWith('/apply-template')) {
        // 템플릿 결과 길이로 구성을 표현한다. 시스템 100자, 도구당 30자
        const hasSystem = body.messages.some((m: any) => m.role === 'system');
        const tools = body.tools?.length ?? 0;
        return { prompt: 'x'.repeat(10 + (hasSystem ? 100 : 0) + tools * 30) };
      }
      // 한 글자가 한 토큰
      return { tokens: Array.from({ length: String(body.content).length }, (_, i) => i) };
    });

    const parts = await measureBreakdown({
      model: 'qwen3',
      provider: 'llamacpp',
      systemPrompt: SYSTEM,
      tools: [BUILTIN, MCP],
    });

    expect(parts).toEqual({ mcpTools: 30, system: 100, tools: 30 });
    // base의 /v1은 떼고 붙인다
    expect(calls.map(call => call.url).sort()).toEqual(
      [
        ...Array(4).fill('http://localhost:8080/apply-template'),
        ...Array(4).fill('http://localhost:8080/tokenize'),
      ].sort(),
    );
    const withAll = calls.find(call => call.url.endsWith('/apply-template') && call.body.tools?.length === 2)!;
    expect(withAll.body.messages[0].role).toBe('system');
  });

  test('anthropic은 count_tokens에 system 필드로 보낸다', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk';
    const calls = stubFetch(({ body }) => ({
      input_tokens: 10 + (body.system ? 100 : 0) + (body.tools?.length ?? 0) * 50,
    }));

    const parts = await measureBreakdown({
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      systemPrompt: SYSTEM,
      tools: [BUILTIN],
    });

    expect(parts).toEqual({ mcpTools: 0, system: 100, tools: 50 });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    // 시스템 프롬프트를 system 역할 메시지로 넣으면 안 된다 (Anthropic은 별도 필드)
    expect(calls.every(call => call.body.messages.length === 1)).toBe(true);
  });

  test('같은 입력이라도 제공자가 다르면 캐시를 공유하지 않는다', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk';
    process.env.VLLM_BASE_URL = 'http://server:8000/v1';
    const calls = stubFetch(({ url }) =>
      url.includes('anthropic') ? { input_tokens: 10 } : { count: 20, max_model_len: 1, tokens: [] },
    );
    const inputs = { model: 'm', systemPrompt: SYSTEM, tools: [] };

    await measureBreakdown({ ...inputs, provider: 'anthropic' });
    await measureBreakdown({ ...inputs, provider: 'vllm' });

    expect(calls.some(call => call.url.endsWith('/tokenize'))).toBe(true);
  });
});
