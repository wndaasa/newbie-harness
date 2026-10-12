// 같은 도구를 같은 인자로 되풀이할 때 루프가 어떻게 다루는지 고정한다.
//
// 결과를 못 알아들은 모델은 같은 호출을 계속 다시 보낸다. 도구는 매번 같은 답을
// 주니 원문을 그대로 쌓으면 이력만 불어난다. 예전에는 아예 실행하지 않고 세 번
// 쌓이면 턴을 끝냈는데, 부를 때마다 결과가 달라지는 도구(read_process 폴링, 고친
// 뒤 다시 돌린 테스트)까지 막혀 일하던 모델이 멈췄다. 이제는 늘 실행하고, 결과가
// 직전과 똑같을 때만 "변화 없음" 한 줄로 줄인다. 작은 모델에서 실제로 겪은 증상이라,
// 판정 함수가 아니라 루프를 그대로 돌려 확인한다.

import { afterAll, expect, mock, test } from 'bun:test';

type Call = { name: string; input: Record<string, unknown> };

const realProviders = { ...(await import('../src/providers/index.ts')) };
const realRegistry = { ...(await import('../src/tools/registry.ts')) };

afterAll(() => {
  mock.module('../src/providers/index.ts', () => realProviders);
  mock.module('../src/tools/registry.ts', () => realRegistry);
});

/**
 * 실행된 도구 호출을 기록하면서 대본대로 답하는 프로바이더. result를 주면 도구
 * 결과를 호출 순번으로 만든다 (기본은 늘 같은 '결과')
 */
function scripted(
  calls: Call[],
  { result = () => '결과', text = () => '' }: { result?: (n: number) => string; text?: (round: number) => string } = {},
) {
  const dispatched: string[] = [];
  const sentMessages: { content?: unknown; role: string }[][] = [];
  let round = 0;

  mock.module('../src/tools/registry.ts', () => ({
    ...realRegistry,
    dispatchTool: async (name: string, input: Record<string, unknown>) => {
      dispatched.push(`${name} ${JSON.stringify(input)}`);
      return { images: [], text: result(dispatched.length) };
    },
  }));

  mock.module('../src/providers/index.ts', () => ({
    ...realProviders,
    buildSystemPrompt: () => '',
    runProviderText: async () => '',
    runProviderTurn: async (session: { messages: { content?: unknown; role: string }[] }) => {
      sentMessages.push(session.messages);
      const call = calls[round];
      round += 1;
      if (!call) return { text: '끝', toolCalls: [], usage: undefined };
      return { text: text(round), usage: undefined, toolCalls: [{ id: `t${round}`, ...call }] };
    },
  }));

  return { dispatched, sentMessages };
}

function session() {
  return {
    messages: [],
    mock: false,
    mode: 'agent',
    model: 'claude-opus-5',
    permissionMode: 'auto',
    provider: 'anthropic',
  } as never;
}

const LIST = { name: 'list_files', input: { path: '.' } };

test('같은 인자로 다시 불러도 실행하고, 결과가 똑같으면 변화 없음으로 줄인다', async () => {
  const { dispatched } = scripted([LIST, LIST]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const { stop, toolTurns } = await runAgentLoop(session(), { output: { write() {} } });

  expect(dispatched.length).toBe(2);
  const second = toolTurns[1]?.toolCalls?.[0];
  expect(second?.ok).toBe(true);
  expect(second?.result).toContain('변화 없음');
  expect(stop.cause).toBe('done');
});

test('결과가 달라지면 원문을 그대로 돌려준다 (뜨는 중인 서버를 다시 보는 폴링)', async () => {
  const POLL = { name: 'read_process', input: { id: 'p1' } };
  const { dispatched } = scripted([POLL, POLL, POLL], { result: n => `실행 중 (${n * 3}초 경과)` });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const { toolTurns } = await runAgentLoop(session(), { output: { write() {} } });

  // 예전에는 두 번째부터 "이미 호출했다"로 막혀 모델이 몇 초 전 결과만 들고 있었다
  expect(dispatched.length).toBe(3);
  expect(toolTurns.map(turn => turn.toolCalls?.[0]?.result)).toEqual([
    '실행 중 (3초 경과)',
    '실행 중 (6초 경과)',
    '실행 중 (9초 경과)',
  ]);
});

test('인자가 다르면 그대로 실행한다', async () => {
  const { dispatched } = scripted([
    { name: 'list_files', input: { path: 'a' } },
    { name: 'list_files', input: { path: 'b' } },
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  await runAgentLoop(session(), { output: { write() {} } });

  // 같은 도구라도 대상이 다르면 다른 호출이다 — 이걸 막으면 탐색이 불가능해진다
  expect(dispatched.length).toBe(2);
});

test('같은 결과가 이어지면 방법을 바꾸라고 재촉하고, 더 이어지면 이유와 함께 멈춘다', async () => {
  // 대본은 열 번을 부르지만, 새로 달라진 결과 없이 다섯 라운드가 이어지면 멈춰야 한다
  const { dispatched, sentMessages } = scripted(Array.from({ length: 10 }, () => LIST));
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const { stop, text, toolTurns } = await runAgentLoop(session(), { output: { write() {} } });

  // 첫 결과(새것) 뒤로 변화 없는 라운드 다섯 번
  expect(dispatched.length).toBe(6);
  expect(toolTurns.length).toBe(6);
  expect(stop.cause).toBe('no_progress');
  expect(text).toBe('');
  // 셋째 변화 없는 라운드 뒤에 재촉이 한 번 들어갔다 (세션 이력에는 남지 않는다)
  const nudged = sentMessages.findIndex(messages =>
    messages.some(m => String(m.content ?? '').includes('새로 달라진 것이 없습니다')),
  );
  expect(nudged).toBe(4);
  expect(toolTurns.some(turn => String(turn.content).includes('새로 달라진 것이 없습니다'))).toBe(false);
});

test('멈춘 턴은 마지막 라운드의 문장을 최종 답으로 되풀이하지 않는다', async () => {
  // 실측 사례: 라운드 상한에 걸린 턴이 25번째 라운드의 "확인하겠습니다."를 도구 호출 없이
  // 한 번 더 찍어, 모델이 예고만 하고 멈춘 것처럼 보였다
  scripted(Array.from({ length: 10 }, () => LIST), { text: () => '확인하겠습니다.' });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const { stop, text, toolTurns } = await runAgentLoop(session(), { output: { write() {} } });

  expect(stop.cause).toBe('no_progress');
  expect(toolTurns.at(-1)?.content).toBe('확인하겠습니다.');
  expect(text).toBe('');
});
