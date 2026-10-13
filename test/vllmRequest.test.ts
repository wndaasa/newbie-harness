// vLLM 요청 본문 회귀 테스트.
//
// vLLM은 생성 전에 "입력 토큰 + max_tokens <= max_model_len"을 검사하고 넘으면
// 400으로 거절한다. max_tokens가 출력 상한이 아니라 예약분이기 때문이다.
// 기본값 32768을 그대로 보냈다가 40960짜리 창에서 두 턴 만에 죽었다 —
// 게이지는 8.8k/41k로 멀쩡해 보여서 원인이 드러나지 않았다.

import { afterEach, describe, expect, test } from 'bun:test';
import { runVllmTurn } from '../src/providers/vllm.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function captureRequest() {
  const sent: { body: any } = { body: null };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.body = JSON.parse(String(init.body));
    // 스트림 파서가 바로 끝나도록 빈 본문을 돌려준다
    return new Response(new ReadableStream({ start: c => c.close() }), { status: 200 });
  }) as never;
  return sent;
}

const OUTPUT = { write: () => {}, writeReasoning: () => {} };

function request(maxTokens: number) {
  return {
    maxTokens,
    messages: [{ role: 'user' as const, content: '안녕' }],
    model: 'qwen3-8b-awq',
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe('vLLM 요청', () => {
  test('기본 상한(32768)은 아예 보내지 않는다', async () => {
    process.env.VLLM_BASE_URL = 'http://server:8000/v1';
    process.env.VLLM_API_KEY = 'k';
    const sent = captureRequest();

    await runVllmTurn(request(32_768) as never, { output: OUTPUT } as never);

    // 보내면 입력이 조금만 쌓여도 400으로 거절된다. 생략하면 vLLM이
    // max_model_len - 입력을 알아서 잡는다
    expect('max_tokens' in sent.body).toBe(false);
  });

  test('작게 잡은 유틸리티 호출은 그대로 보낸다', async () => {
    process.env.VLLM_BASE_URL = 'http://server:8000/v1';
    process.env.VLLM_API_KEY = 'k';
    const sent = captureRequest();

    // 제목 생성처럼 일부러 작게 준 값은 그 상한이 의미가 있다
    await runVllmTurn(request(256) as never, { output: OUTPUT } as never);

    expect(sent.body.max_tokens).toBe(256);
  });

  test('짧은 유틸리티 호출은 생각을 끈다', async () => {
    process.env.VLLM_BASE_URL = 'http://server:8000/v1';
    process.env.VLLM_API_KEY = 'k';
    const sent = captureRequest();

    // Qwen3의 생각도 완성 토큰을 쓴다. 켜 둔 채로 60토큰을 주면 그 60을 생각이
    // 다 먹고 본문이 비어 자동 제목이 안 붙는다
    await runVllmTurn(
      { ...request(60), noReasoning: true } as never,
      { output: OUTPUT } as never,
    );

    expect(sent.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('보통 턴은 생각을 끄지 않는다', async () => {
    process.env.VLLM_BASE_URL = 'http://server:8000/v1';
    process.env.VLLM_API_KEY = 'k';
    const sent = captureRequest();

    await runVllmTurn(request(32_768) as never, { output: OUTPUT } as never);

    // 대화 턴의 생각은 접이식 블록으로 보여 주는 값이라 버리지 않는다
    expect('chat_template_kwargs' in sent.body).toBe(false);
    expect(sent.body.reasoning_effort).toBe('medium');
  });

  test('사고 강도를 Qwen3.8 템플릿 값으로 옮겨 보낸다', async () => {
    process.env.VLLM_BASE_URL = 'http://server:8000/v1';
    process.env.VLLM_API_KEY = 'k';

    // 안 보내면 템플릿 기본값 xhigh — 단순한 지시에도 최대 깊이로 생각한다
    let sent = captureRequest();
    await runVllmTurn(request(32_768) as never, { output: OUTPUT } as never);
    expect(sent.body.reasoning_effort).toBe('medium');

    // UI의 high는 템플릿에 없다. 모르는 값은 템플릿이 예외를 던져 400이 된다
    sent = captureRequest();
    await runVllmTurn(
      { ...request(32_768), reasoningEffort: 'high' } as never,
      { output: OUTPUT } as never,
    );
    expect(sent.body.reasoning_effort).toBe('xhigh');

    sent = captureRequest();
    await runVllmTurn(
      { ...request(32_768), reasoningEffort: 'low' } as never,
      { output: OUTPUT } as never,
    );
    expect(sent.body.reasoning_effort).toBe('low');

    // '끔'은 사고 자체를 끈다
    sent = captureRequest();
    await runVllmTurn(
      { ...request(32_768), reasoningEffort: 'none' } as never,
      { output: OUTPUT } as never,
    );
    expect('reasoning_effort' in sent.body).toBe(false);
    expect(sent.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test('설정창의 샘플링 값을 보내고, 비어 있으면 보내지 않는다', async () => {
    process.env.VLLM_BASE_URL = 'http://server:8000/v1';
    process.env.VLLM_API_KEY = 'k';

    let sent = captureRequest();
    await runVllmTurn(request(32_768) as never, { output: OUTPUT } as never);
    // 안 보내야 모델 generation_config의 권장값이 그대로 쓰인다
    expect('temperature' in sent.body).toBe(false);

    process.env.NEWBIE_TEMPERATURE = '0.7';
    process.env.NEWBIE_TOP_K = '20';
    sent = captureRequest();
    await runVllmTurn(request(32_768) as never, { output: OUTPUT } as never);
    expect(sent.body.temperature).toBe(0.7);
    expect(sent.body.top_k).toBe(20);
    expect('top_p' in sent.body).toBe(false);
  });

  test('주소를 있는 그대로 쓴다', async () => {
    process.env.VLLM_BASE_URL = 'http://server:8000/v1';
    process.env.VLLM_API_KEY = 'k';
    let url = '';
    globalThis.fetch = (async (u: string) => {
      url = String(u);
      return new Response(new ReadableStream({ start: c => c.close() }), { status: 200 });
    }) as never;

    await runVllmTurn(request(256) as never, { output: OUTPUT } as never);

    // /v1을 덧붙이면 /v1/v1/chat/completions로 나가 404가 난다
    expect(url).toBe('http://server:8000/v1/chat/completions');
  });

  test('키가 있을 때만 인증 헤더를 붙인다', async () => {
    process.env.VLLM_BASE_URL = 'http://server:8000/v1';
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(new ReadableStream({ start: c => c.close() }), { status: 200 });
    }) as never;

    process.env.VLLM_API_KEY = 'k';
    await runVllmTurn(request(256) as never, { output: OUTPUT } as never);
    expect(headers.authorization).toBe('Bearer k');

    // --api-key 없이 띄운 서버는 헤더 없이 받는다. 키를 건 서버라면 401이 키 거부로 보인다
    delete process.env.VLLM_API_KEY;
    await runVllmTurn(request(256) as never, { output: OUTPUT } as never);
    expect('authorization' in headers).toBe(false);
  });

  test('주소가 없으면 무엇을 넣어야 하는지 말해 준다', async () => {
    delete process.env.VLLM_BASE_URL;
    process.env.VLLM_API_KEY = 'k';
    captureRequest();

    await expect(
      runVllmTurn(request(256) as never, { output: OUTPUT } as never),
    ).rejects.toThrow(/설정 > 제공자/);
  });
});
