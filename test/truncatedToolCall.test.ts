// 인자가 잘린 도구 호출 회귀 테스트.
//
// 모델이 긴 파일을 create_file 인자로 만들다 응답 토큰 한도에 걸려 잘리면, 인자
// JSON이 깨져 파싱되지 않는다. 예전에는 이런 호출을 조용히 버려서, 루프엔
// "생성하겠습니다" 텍스트만 남고 도구 호출이 사라져 정체가 됐다 — 모델은 자기
// 호출이 버려진 줄도 몰랐다. 이제는 버리지 않고 truncated로 표시해, 루프가
// "잘렸으니 나눠서 다시 하라"고 결과로 돌려준다.

import { expect, mock, test } from 'bun:test';
import { readOpenAIStream } from '../src/providers/streams.ts';

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${c}\n\n`));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

test('OpenAI 스트림: 인자가 잘린 도구 호출을 버리지 않고 truncated로 표시한다', async () => {
  // arguments가 중간에 끊긴 (닫히지 않은) JSON
  const body = sseStream([
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'create_file', arguments: '{"path":"src/App.tsx","content":"import React' } }] } }],
    }),
  ]);

  const result = await readOpenAIStream(body, { write() {} });

  expect(result.toolCalls.length).toBe(1);
  expect(result.toolCalls[0].name).toBe('create_file');
  expect(result.toolCalls[0].truncated).toBe(true);
});

test('OpenAI 스트림: 정상 인자는 truncated 없이 그대로 파싱한다', async () => {
  const body = sseStream([
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }],
    }),
  ]);

  const result = await readOpenAIStream(body, { write() {} });

  expect(result.toolCalls[0].truncated).toBeUndefined();
  expect(result.toolCalls[0].input).toEqual({ path: '.' });
});

// --- 루프 동작 ---

function scriptProvider(responses: any[]) {
  const state = { calls: 0 };
  mock.module('../src/providers/index.ts', () => ({
    buildSystemPrompt: () => '',
    runProviderTurn: async () => responses[Math.min(state.calls++, responses.length - 1)],
  }));
  return state;
}

function session() {
  return {
    messages: [], mock: false, mode: 'agent',
    model: 'claude-opus-5', permissionMode: 'auto', provider: 'anthropic',
  } as any;
}

test('루프: 잘린 도구 호출은 실행하지 않고 "나눠서 다시 하라"고 돌려주며 이어간다', async () => {
  const state = scriptProvider([
    // 잘린 create_file — 실행하면 안 되고 회복 안내를 줘야 한다
    { text: '이제 App.tsx를 만들겠습니다.', usage: undefined,
      toolCalls: [{ id: 't1', name: 'create_file', input: {}, truncated: true }] },
    // 모델이 회복해 작은 읽기부터 다시 — 정상 진행 확인용
    { text: '', usage: undefined,
      toolCalls: [{ id: 't2', name: 'list_files', input: { path: '.' } }] },
    { text: '완료했습니다.', toolCalls: [], usage: undefined },
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const started: string[] = [];
  const { toolTurns, text } = await runAgentLoop(session(), {
    output: { write: () => {} },
    onToolEvent: e => { if (e.phase === 'start') started.push(e.name); },
  });

  const first = (toolTurns[0].toolCalls as any[])[0];
  expect(first.ok).toBe(false);
  expect(first.result).toContain('잘렸습니다');
  expect(first.result).toContain('나누');
  // 잘린 create_file은 실제로 실행되지 않았다 (start 이벤트 없음)
  expect(started).not.toContain('create_file');
  // 그리고 작업은 멈추지 않고 이어졌다
  expect(started).toContain('list_files');
  expect(text).toBe('완료했습니다.');
});
