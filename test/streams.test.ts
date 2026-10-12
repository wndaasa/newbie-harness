// 스트림 파싱 회귀 테스트.
//
// 리더들이 JSON.parse를 무방비로 부르던 시절에는, 프로바이더가 보낸 청크 하나가
// 깨지면 이미 받아둔 텍스트와 도구 호출까지 통째로 버려지고 턴이 오류로 끝났다.

import { describe, expect, test } from 'bun:test';
import { readAnthropicStream, readOpenAIStream } from '../src/providers/streams.ts';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function collector() {
  const written: string[] = [];
  return { output: { write: (c: string) => written.push(c) }, written };
}

describe('Anthropic 스트림', () => {
  test('중간에 깨진 이벤트가 있어도 앞뒤 텍스트를 잃지 않는다', async () => {
    const { output, written } = collector();
    const result = await readAnthropicStream(
      streamOf([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"앞"}}\n\n',
        'data: {깨진 JSON\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"뒤"}}\n\n',
      ]),
      output,
    );

    expect(result.text).toBe('앞뒤');
    expect(written.join('')).toBe('앞뒤');
  });

  test('도구 호출 인자 JSON이 잘리면 버리지 않고 truncated로 표시한다', async () => {
    const { output } = collector();
    const result = await readAnthropicStream(
      streamOf([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"read_file"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"계속"}}\n\n',
      ]),
      output,
    );

    // 버리면 모델이 자기 호출이 사라진 줄 모르고 정체에 빠진다. 잘린 인자로
    // 실행하지는 않되(input은 비움), truncated로 남겨 루프가 회복을 안내하게 한다
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].truncated).toBe(true);
    expect(result.toolCalls[0].input).toEqual({});
    expect(result.text).toBe('계속');
  });

  test('온전한 도구 호출은 그대로 살린다', async () => {
    const { output } = collector();
    const result = await readAnthropicStream(
      streamOf([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"read_file"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
      ]),
      output,
    );

    expect(result.toolCalls).toEqual([
      { id: 't1', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  });

  test('usage를 읽어 컨텍스트 게이지에 넘긴다', async () => {
    const { output } = collector();
    const result = await readAnthropicStream(
      streamOf([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}\n\n',
      ]),
      output,
    );

    // 캐시 토큰도 컨텍스트를 차지하므로 합산해야 한다
    expect(result.usage).toEqual({ cachedInputTokens: 5, inputTokens: 15, outputTokens: 1 });
  });
});

describe('OpenAI 스트림', () => {
  test('깨진 청크를 건너뛰고 이어서 읽는다', async () => {
    const { output } = collector();
    const result = await readOpenAIStream(
      streamOf([
        'data: {"choices":[{"delta":{"content":"하나"}}]}\n\n',
        'data: 깨짐\n\n',
        'data: {"choices":[{"delta":{"content":"둘"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
      output,
    );

    expect(result.text).toBe('하나둘');
  });

  test('인자 JSON이 잘린 도구 호출은 버리지 않고 truncated로 표시한다', async () => {
    const { output } = collector();
    const result = await readOpenAIStream(
      streamOf([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
      output,
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].truncated).toBe(true);
    expect(result.toolCalls[0].input).toEqual({});
  });
});

// ── 종료 사유 ─────────────────────────────────────────────────────────────────
//
// 턴이 왜 거기서 끝났는지(특히 출력 상한에 잘렸는지)를 리더가 버려서, 모델이
// 일하다 말고 멈춘 것처럼 보일 때 원인을 되짚을 길이 없었다.

describe('종료 사유', () => {
  test('OpenAI finish_reason은 delta가 비어 있어도 읽는다', async () => {
    const { output } = collector();
    const result = await readOpenAIStream(
      streamOf([
        'data: {"choices":[{"delta":{"content":"앞"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
      output,
    );
    expect(result.text).toBe('앞');
    expect(result.stopReason).toBe('length');
  });

  test('Anthropic stop_reason은 OpenAI 어휘로 맞춘다', async () => {
    const { output } = collector();
    const result = await readAnthropicStream(
      streamOf([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"앞"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}}\n\n',
      ]),
      output,
    );
    expect(result.stopReason).toBe('length');
  });
});
