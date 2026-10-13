// Ollama 컨텍스트 창 회귀 테스트.
//
// Ollama는 요청에 num_ctx가 없으면 서버 기본값으로 모델을 올린다. 그래픽카드 메모리가
// 24GiB 미만이면 4K인데, 앱은 모델 최대치(gemma4:e4b는 128K)를 창으로 알고 있어서
// 압축이 걸리기 전에 Ollama 쪽 창이 먼저 넘쳤다. 앱이 정한 창을 num_ctx로 같이 보내
// 둘을 맞춘다. 조회 캐시가 모듈 전역이라 테스트마다 모델 이름을 다르게 쓴다.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  OLLAMA_DEFAULT_NUM_CTX,
  fetchContextWindow,
  resolveContextWindow,
} from '../src/providers/contextWindow.ts';
import { runOllamaTurn } from '../src/providers/ollama.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** /api/show 응답을 흉내 낸다 */
function mockShow({ parameters = '', contextLength }: { parameters?: string; contextLength?: number }) {
  globalThis.fetch = (async () =>
    Response.json({
      parameters,
      model_info: contextLength ? { 'gemma4.context_length': contextLength } : {},
    })) as never;
}

describe('Ollama 컨텍스트 창', () => {
  test('Modelfile에 num_ctx가 없으면 기본값을 모델 최대치 안에서 쓴다', async () => {
    mockShow({ contextLength: 131_072 });
    expect(await fetchContextWindow('ollama', 'window-big:e4b')).toBe(OLLAMA_DEFAULT_NUM_CTX);

    mockShow({ contextLength: 4_096 });
    expect(await fetchContextWindow('ollama', 'window-small:1b')).toBe(4_096);
  });

  test('Modelfile에 num_ctx가 있으면 그 값을 쓴다', async () => {
    mockShow({ parameters: 'num_ctx 65536\nstop "<end>"', contextLength: 131_072 });
    expect(await fetchContextWindow('ollama', 'window-modelfile:latest')).toBe(65_536);
  });

  test('조회 전에도 기본값을 쓴다', () => {
    expect(resolveContextWindow('ollama', 'window-unfetched:latest')).toBe(OLLAMA_DEFAULT_NUM_CTX);
  });

  test('앱이 아는 창 크기를 num_ctx로 같이 보낸다', async () => {
    mockShow({ contextLength: 131_072 });
    await fetchContextWindow('ollama', 'window-request:e4b');

    let body: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(new ReadableStream({ start: c => c.close() }), { status: 200 });
    }) as never;
    await runOllamaTurn(
      {
        maxTokens: 256,
        messages: [{ role: 'user', content: '안녕' }],
        model: 'window-request:e4b',
      } as never,
      { output: { write: () => {}, writeReasoning: () => {} } } as never,
    );

    expect(body.options.num_ctx).toBe(OLLAMA_DEFAULT_NUM_CTX);
    expect(body.options.num_predict).toBe(256);
  });
});
