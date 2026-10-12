// OpenAI Responses API 경로 회귀 테스트.
//
// gpt-5 계열은 chat/completions에서 tools와 추론을 함께 받지 않아 코딩 탭이 늘
// 추론을 끈 채 돌았다. Responses로 옮기면서 이력 변환과 스트림 파싱이 새로
// 생겼는데, 여기가 틀리면 증상이 "가끔 도구 호출이 사라진다"처럼 흐릿하게 나와
// 원인을 찾기 어렵다. 형태를 테스트로 고정한다.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REASONING_EFFORT,
  resolveReasoningEffort,
  toResponsesInput,
  toResponsesTools,
} from '../src/providers/openaiResponses.ts';
import { readOpenAIResponsesStream } from '../src/providers/streams.ts';

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

function sse(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe('추론 강도', () => {
  test('환경 변수가 없거나 모르는 값이면 기본값', () => {
    expect(resolveReasoningEffort(undefined)).toBe(DEFAULT_REASONING_EFFORT);
    expect(resolveReasoningEffort('turbo')).toBe(DEFAULT_REASONING_EFFORT);
  });

  test('아는 값은 대소문자·공백을 정리해 그대로 쓴다', () => {
    expect(resolveReasoningEffort(' High ')).toBe('high');
    expect(resolveReasoningEffort('none')).toBe('none');
  });
});

describe('도구 정의 변환', () => {
  test('chat 포맷의 function 래퍼를 평면으로 편다', () => {
    const [tool] = toResponsesTools([
      {
        type: 'function',
        function: { name: 'read_file', description: '읽기', parameters: { type: 'object' } },
      },
    ]);
    expect(tool).toEqual({
      type: 'function',
      name: 'read_file',
      description: '읽기',
      parameters: { type: 'object' },
    });
  });
});

describe('이력 변환', () => {
  test('도구 호출 왕복을 function_call / function_call_output 항목으로 바꾼다', () => {
    const items = toResponsesInput([
      { role: 'developer', content: '시스템' },
      { role: 'user', content: '파일 읽어줘' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '내용' },
      { role: 'assistant', content: '읽었습니다' },
    ]);

    expect(items).toEqual([
      { role: 'user', content: '파일 읽어줘' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '내용' },
      { role: 'assistant', content: '읽었습니다' },
    ]);
  });

  test('function_call 항목에 id를 싣지 않는다', () => {
    // id가 있으면 API가 짝이 되는 reasoning 항목까지 요구하는데, 세션은 그것을
    // 저장하지 않는다. call_id만으로 왕복이 성립한다
    const [call] = toResponsesInput([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'ping', arguments: '{}' } }],
      },
    ]) as Array<Record<string, unknown>>;
    expect(call).not.toHaveProperty('id');
    expect(call.call_id).toBe('call_9');
  });

  test('이미지가 든 user 메시지는 input_text / input_image 파트로 바꾼다', () => {
    const [message] = toResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: '이 화면 봐줘' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]) as Array<{ content: unknown }>;
    expect(message.content).toEqual([
      { type: 'input_text', text: '이 화면 봐줘' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ]);
  });
});

describe('Responses 스트림', () => {
  test('텍스트와 도구 호출, usage를 읽는다', async () => {
    const { output, written } = collector();
    const result = await readOpenAIResponsesStream(
      streamOf([
        sse({ type: 'response.created', response: {} }),
        sse({ type: 'response.output_text.delta', delta: '읽어' }),
        sse({ type: 'response.output_text.delta', delta: '볼게요' }),
        sse({
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' },
        }),
        sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' }),
        sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '"a.ts"}' }),
        sse({ type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"a.ts"}' }),
        sse({
          type: 'response.completed',
          response: {
            usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 7 },
          },
        }),
      ]),
      output,
    );

    expect(result.text).toBe('읽어볼게요');
    expect(written.join('')).toBe('읽어볼게요');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    ]);
    expect(result.usage).toEqual({ cachedInputTokens: 100, inputTokens: 120, outputTokens: 7 });
  });

  test('인자가 잘리면 버리지 않고 truncated로 표시한다', async () => {
    const { output } = collector();
    const result = await readOpenAIResponsesStream(
      streamOf([
        sse({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_1', name: 'create_file', arguments: '' },
        }),
        sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"a.ts","content":"' }),
        sse({ type: 'response.incomplete', response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
      ]),
      output,
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].truncated).toBe(true);
    expect(result.toolCalls[0].input).toEqual({});
  });

  test('added를 놓쳐도 output_item.done으로 호출을 복원한다', async () => {
    const { output } = collector();
    const result = await readOpenAIResponsesStream(
      streamOf([
        'data: {깨진 JSON\n\n',
        sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"n":1}' }),
        sse({
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_7', name: 'ping', arguments: '{"n":1}' },
        }),
      ]),
      output,
    );

    expect(result.toolCalls).toEqual([{ id: 'call_7', name: 'ping', input: { n: 1 } }]);
  });

  test('추론 요약은 writeReasoning으로 흘리고 결과에도 담는다', async () => {
    const written: string[] = [];
    const reasoned: string[] = [];
    const result = await readOpenAIResponsesStream(
      streamOf([
        sse({ type: 'response.reasoning_summary_part.added', output_index: 0 }),
        sse({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '**Plan**' }),
        sse({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: ' first' }),
        sse({ type: 'response.reasoning_summary_part.added', output_index: 0 }),
        sse({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'then' }),
        sse({ type: 'response.output_text.delta', delta: '답' }),
      ]),
      { write: c => written.push(c), writeReasoning: c => reasoned.push(c) },
    );

    expect(result.reasoning).toBe('**Plan** first\n\nthen');
    expect(reasoned.join('')).toBe('**Plan** first\n\nthen');
    // 본문 출력에는 섞이지 않는다
    expect(written.join('')).toBe('답');
    expect(result.text).toBe('답');
  });

  test('요약 수신자가 없어도 본문은 그대로 읽힌다', async () => {
    const { output } = collector();
    const result = await readOpenAIResponsesStream(
      streamOf([
        sse({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'x' }),
        sse({ type: 'response.output_text.delta', delta: '답' }),
      ]),
      output,
    );
    expect(result.text).toBe('답');
    expect(result.reasoning).toBe('x');
  });

  test('response.failed는 오류로 올린다', async () => {
    const { output } = collector();
    await expect(
      readOpenAIResponsesStream(
        streamOf([sse({ type: 'response.failed', response: { error: { message: '한도 초과' } } })]),
        output,
      ),
    ).rejects.toThrow('한도 초과');
  });
});
