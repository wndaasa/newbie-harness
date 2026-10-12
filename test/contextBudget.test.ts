// 컨텍스트 예산 회귀 테스트.
//
// 로컬 모델(vLLM Qwen3-8B는 40,960)에서는 한 턴에 파일을 몇 번 읽는 것만으로 창이
// 찬다. 넘치면 400으로 턴이 죽었다. 여기서 고정하는 것은 네 가지다 — 시스템
// 프롬프트까지 실측에 넣어 세고, 출력 예약분은 남은 창 안으로 잡고, 턴 하나가 창을
// 채우면 그 턴의 오래된 라운드까지 접고, 그래도 거절되면 오래된 도구 결과를 줄여
// 한 번 다시 보낸다.

import { afterAll, expect, mock, test } from 'bun:test';
import { ProviderRequestError } from '../src/providers/fetchWithRetry.ts';

const realProviders = { ...(await import('../src/providers/index.ts')) };
const realWindow = { ...(await import('../src/providers/contextWindow.ts')) };

afterAll(() => {
  mock.module('../src/providers/index.ts', () => realProviders);
  mock.module('../src/providers/contextWindow.ts', () => realWindow);
});

type Sent = { maxTokens: number; messages: { content?: unknown; role: string }[] };

/** 창 크기와 실측 토큰을 고정하고, 보낸 요청을 기록하는 프로바이더 */
function scripted({
  counted,
  failTimes = 0,
  window,
}: {
  /** 실측 토큰. 함수면 보낸 메시지 목록으로 계산한다 */
  counted: number | ((messages: unknown[]) => number);
  failTimes?: number;
  window: number;
}) {
  const sent: Sent[] = [];
  const countedWith: unknown[][] = [];
  /** 요약(runProviderText) 호출 횟수 — 접을 때만 늘어야 한다 */
  const summaries: number[] = [];
  let calls = 0;

  mock.module('../src/providers/contextWindow.ts', () => ({
    ...realWindow,
    resolveContextWindow: () => window,
  }));
  mock.module('../src/providers/index.ts', () => ({
    ...realProviders,
    countProviderTokens: async (_session: unknown, messages: unknown[]) => {
      countedWith.push(messages);
      return typeof counted === 'function' ? counted(messages) : counted;
    },
    runProviderText: async () => {
      summaries.push(1);
      return '요약';
    },
    runProviderTurn: async (session: Sent) => {
      calls += 1;
      sent.push({ maxTokens: session.maxTokens, messages: session.messages });
      if (calls <= failTimes) {
        throw new ProviderRequestError({
          body: "This model's maximum context length is 40960 tokens. However, you requested 40961 tokens.",
          message: 'vLLM 요청 실패 (400)',
          provider: 'vLLM',
          status: 400,
        });
      }
      return { text: '끝', toolCalls: [], usage: undefined };
    },
  }));

  return { countedWith, sent, summaries };
}

const big = '내용'.repeat(500);
function toolRound(id: string) {
  return {
    content: '',
    role: 'assistant',
    toolCalls: [{ id, input: { path: id }, name: 'read_file', ok: true, result: big }],
  };
}

function session() {
  return {
    maxTokens: 32_768,
    messages: [{ content: '읽어 줘', role: 'user' }, toolRound('a'), toolRound('b'), toolRound('c')],
    mock: false,
    mode: 'agent',
    model: 'qwen3-8b-awq',
    permissionMode: 'auto',
    provider: 'vllm',
  } as never;
}

/** 도구 정의는 /tokenize에 못 넣어 어림하므로, 계산을 고정하려고 도구를 비운다 */
const context = { allowTool: () => false, output: { write() {} } };

test('시스템 프롬프트를 실측에 포함한다', async () => {
  const { countedWith } = scripted({ counted: 100, window: 100_000 });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  await runAgentLoop(session(), { ...context, systemPrompt: '지침입니다' });

  // 한국어 지침을 글자 수로 어림하면 절반으로 적게 센다. 제공자가 셀 수 있으면
  // 이력 앞에 system으로 붙여 같이 잰다
  expect(countedWith[0][0]).toEqual({ content: '지침입니다', role: 'system' });
});

test('출력 예약분은 남은 창을 넘지 않는다', async () => {
  const { sent } = scripted({ counted: 10_000, window: 20_000 });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  await runAgentLoop(session(), context);

  // 빈 도구 목록 "[]"은 1토큰으로 어림된다 → 입력 10,001. 출력 예약 4,096을 뺀
  // 나머지가 상한이다. 설정값 32,768을 그대로 보내면 vLLM이 생성 전에 거절한다
  expect(sent[0].maxTokens).toBe(20_000 - 10_001 - 4_096);
});

test('창이 넉넉하면 설정값을 그대로 쓴다', async () => {
  const { sent } = scripted({ counted: 100, window: 1_000_000 });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  await runAgentLoop(session(), context);

  expect(sent[0].maxTokens).toBe(32_768);
});

test('컨텍스트 초과로 거절되면 오래된 도구 결과를 줄여 한 번 다시 보낸다', async () => {
  const { sent } = scripted({ counted: 100, failTimes: 1, window: 100_000 });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const result = await runAgentLoop(session(), context);

  expect(result.text).toBe('끝');
  expect(sent.length).toBe(2);
  const toolResults = (request: Sent) =>
    request.messages.filter(m => m.role === 'tool').map(m => String(m.content));
  // 첫 시도는 원문 그대로 나갔고, 재시도는 직전 라운드만 원문이다
  expect(toolResults(sent[0])).toEqual([big, big, big]);
  const retry = toolResults(sent[1]);
  expect(retry[0]).toContain('생략');
  expect(retry[1]).toContain('생략');
  expect(retry[2]).toBe(big);
});

test('줄여서 보내도 거절되면 멈추고 이유를 돌려준다', async () => {
  const { sent } = scripted({ counted: 100, failTimes: 2, window: 100_000 });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  // 한 번만 줄여서 다시 보낸다 — 계속 줄이며 두드리면 라운드만 태운다. 오류로 올리지
  // 않고 멈춘 이유로 돌려줘야 호출자가 이 턴에 끝낸 도구 라운드를 이력에 남길 수 있다
  const result = await runAgentLoop(session(), context);
  expect(result.stop.cause).toBe('context');
  expect(result.text).toBe('');
  expect(sent.length).toBe(2);
});

test('한 번 접으면 다음 턴은 요약을 다시 만들지 않고 이어간다', async () => {
  // 메시지 하나를 7,000토큰으로 센다(system 제외). 첫 턴은 13건 → 91,000으로 접는
  // 선(100,000 − 12,000)을 넘어 접히고, 접힌 뒤엔 머리 둘과 요청 하나 → 21,000.
  // 예전에는 다음 턴이 원본 이력에서 다시 시작해 또 접었다 — 매 턴 요약 호출이
  // 붙고 알림이 매번 떴다
  const { sent, summaries } = scripted({
    counted: messages => 7_000 * (messages.length - 1),
    window: 100_000,
  });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const stored: { content: string; role: string }[] = [];
  for (let i = 1; i <= 6; i += 1) stored.push({ content: `요청 ${i}`, role: 'user' }, { content: `답변 ${i}`, role: 'assistant' });
  stored.push({ content: '요청 7', role: 'user' });
  const live = { ...(session() as object), messages: stored, sessionId: 'loop-s1' } as never;

  const compactions: number[] = [];
  const first = await runAgentLoop(live, { ...context, onCompact: () => compactions.push(1) });
  // 컨트롤러가 하는 대로: 턴 결과를 세션에 붙이고, 접힌 자리를 인덱스로 바꿔 세션에 두고,
  // 다음 요청을 넣는다
  stored.push(...first.toolTurns, { content: first.text, role: 'assistant' });
  expect(first.compaction).toBeDefined();
  (live as { compaction?: unknown }).compaction = {
    foldedCount: stored.indexOf(first.compaction!.lastFolded as never) + 1,
    prompts: first.compaction!.prompts,
    summary: first.compaction!.summary,
  };
  stored.push({ content: '요청 8', role: 'user' });
  const second2 = await runAgentLoop(live, { ...context, onCompact: () => compactions.push(1) });
  // 둘째 턴은 새로 접지 않았으니 기록할 것도 없다
  expect(second2.compaction).toBeUndefined();

  expect(summaries.length).toBe(1);
  expect(compactions.length).toBe(1);
  // 둘째 턴도 접힌 머리(요약·요청 목록)로 시작하고, 그 뒤에 새 요청이 붙는다
  const second = sent[1].messages;
  expect(String(second[0].content)).toContain('지금까지의 대화가 길어져');
  expect(String(second[0].content)).toContain('1. 요청 1');
  expect(second.at(-1)).toEqual({ content: '요청 8', role: 'user' });
});

test('과거에 한 번 접힌 세션이라도 지금 창에 여유가 있으면 도구 결과를 줄이지 않는다', async () => {
  // 예전에는 (folded || ...)라서 세션이 살면서 단 한 번이라도 압축된 적이 있으면,
  // 그 뒤로는 창 여유와 무관하게 매 라운드 직전 두 라운드를 뺀 나머지를 전부
  // "다시 호출하세요"로 잘랐다 — 262K 창에 여유가 넘쳐도 여러 파일을 훑는
  // 조사에서 세 번째 파일부터 내용이 지워지고, 안내를 따라 이미 읽은 파일을
  // 다시 읽길 반복해 끝나지 않는 원인이었다.
  const { sent } = scripted({ counted: 1_000, window: 200_000 });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  // 아주 오래전에 앞 두 메시지(요청 1건 + 도구 라운드 1건)가 이미 한 번 접혔던
  // 세션. 그 뒤로 새 요청과 도구 라운드 셋(a, b, c)이 원문으로 이어져 있다
  const stored = [
    { content: '요청 1', role: 'user' },
    toolRound('old'),
    { content: '요청 2', role: 'user' },
    toolRound('a'),
    toolRound('b'),
    toolRound('c'),
  ];
  const live = {
    ...(session() as object),
    compaction: { foldedCount: 2, prompts: ['요청 1'], summary: '이전 요약' },
    messages: stored,
  } as never;

  await runAgentLoop(live, context);

  const toolResults = sent[0].messages
    .filter((m: { role: string }) => m.role === 'tool')
    .map((m: { content?: unknown }) => String(m.content));
  // 셋 다 원문 그대로 나가야 한다. 예전에는 'a'가 "이전 도구 결과 생략"으로 잘렸다
  for (const id of ['a', 'b', 'c']) {
    expect(toolResults.some(text => text === big)).toBe(true);
  }
  expect(toolResults.some(text => text.includes('생략'))).toBe(false);
});

test('턴 하나가 창을 채우면 그 턴의 오래된 라운드를 접고, 접힌 결과를 다시 부르면 원문을 돌려준다', async () => {
  // 한 턴에 파일 셋을 읽어 창이 70%를 넘으면, 예전에는 진행 중인 턴을 접을 수 없어
  // 도구 결과 축약만으로 버텼다. 이제는 최근 두 라운드만 원문으로 두고 그 앞을 접는다.
  // 그 뒤 모델이 접힌 파일을 다시 읽으려 하면 "변화 없음"이 아니라 원문이 가야 한다
  const realRegistry = { ...(await import('../src/tools/registry.ts')) };
  const dispatched: string[] = [];
  mock.module('../src/tools/registry.ts', () => ({
    ...realRegistry,
    dispatchTool: async (name: string, input: Record<string, unknown>) => {
      dispatched.push(`${name} ${input.path}`);
      return { images: [], text: '내용'.repeat(500) };
    },
  }));
  const script = ['a', 'b', 'c', 'a'];
  let round = 0;
  const sent: Sent[] = [];
  mock.module('../src/providers/contextWindow.ts', () => ({
    ...realWindow,
    resolveContextWindow: () => 40_000,
  }));
  mock.module('../src/providers/index.ts', () => ({
    ...realProviders,
    // tool 메시지 하나를 10,000토큰으로 센다 → 세 번째 읽기 뒤(31,000)에 70%를 넘는다
    countProviderTokens: async (_s: unknown, messages: { role?: string }[]) =>
      10_000 * messages.filter(m => m.role === 'tool').length + 1_000,
    runProviderText: async () => '요약',
    runProviderTurn: async (session: Sent) => {
      sent.push({ maxTokens: session.maxTokens, messages: session.messages });
      const path = script[round];
      round += 1;
      if (!path) return { text: '끝', toolCalls: [], usage: undefined };
      return { text: '', toolCalls: [{ id: `t${round}`, input: { path }, name: 'read_file' }], usage: undefined };
    },
  }));
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const live = { ...(session() as object), messages: [{ content: '읽어', role: 'user' }], sessionId: 'loop-s2' } as never;
  const result = await runAgentLoop(live, { allowTool: name => name === 'read_file', output: { write() {} } });

  // 네 번째 요청(a를 다시 읽기 직전)은 접힌 머리로 시작하고, 원문은 최근 두 라운드(b, c)뿐이다
  const fourth = sent[3].messages;
  expect(String(fourth[0].content)).toContain('지금까지의 대화가 길어져');
  expect(String(fourth[0].content)).toContain('1. 읽어');
  expect(fourth.filter(m => m.role === 'tool').length).toBe(2);
  // 머리 바로 뒤가 assistant 라운드라 "받았다" 한 줄은 넣지 않는다 (assistant가 연달아 오지 않게)
  expect(fourth[1].role).toBe('assistant');
  // a는 접힌 뒤 다시 읽혀 두 번 실행됐고, 두 번째 결과도 원문이다
  expect(dispatched.filter(d => d === 'read_file a').length).toBe(2);
  const reread = result.toolTurns.at(-1)?.toolCalls?.[0]?.result ?? '';
  expect(reread).toBe('내용'.repeat(500));
  expect(result.compaction).toBeDefined();
  mock.module('../src/tools/registry.ts', () => realRegistry);
});

/** 대본대로 read_file을 부르는 프로바이더와 도구. 요약 호출 수를 센다 */
function scriptedReads(rounds: number, counted: (messages: { role?: string }[]) => number, window: number) {
  const summaries: number[] = [];
  let round = 0;
  mock.module('../src/providers/contextWindow.ts', () => ({
    ...realWindow,
    resolveContextWindow: () => window,
  }));
  mock.module('../src/providers/index.ts', () => ({
    ...realProviders,
    countProviderTokens: async (_s: unknown, messages: { role?: string }[]) => counted(messages),
    runProviderText: async () => {
      summaries.push(1);
      return '요약';
    },
    runProviderTurn: async () => {
      round += 1;
      if (round > rounds) return { text: '끝', toolCalls: [], usage: undefined };
      return { text: '', toolCalls: [{ id: `t${round}`, input: { path: `f${round}` }, name: 'read_file' }], usage: undefined };
    },
  }));
  return summaries;
}

test('접어도 임계 아래로 내려가지 않으면 그 턴에는 다시 접지 않는다', async () => {
  // 시스템 프롬프트와 도구 정의만으로 창이 거의 차는 작은 창. 무엇을 접어도 9,000에서
  // 내려가지 않으니, 라운드마다 요약을 부르지 말고 한 번 접은 뒤로는 축약에 맡긴다
  const realRegistry = { ...(await import('../src/tools/registry.ts')) };
  mock.module('../src/tools/registry.ts', () => ({
    ...realRegistry,
    dispatchTool: async () => ({ images: [], text: '내용' }),
  }));
  const summaries = scriptedReads(8, () => 9_000, 10_000);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const stored = [
    { content: '요청 1', role: 'user' },
    { content: '답변 1', role: 'assistant' },
    { content: '요청 2', role: 'user' },
  ];
  const compactions: number[] = [];
  const live = { ...(session() as object), messages: stored, sessionId: 'loop-s3' } as never;
  const result = await runAgentLoop(live, {
    allowTool: name => name === 'read_file',
    onCompact: () => compactions.push(1),
    output: { write() {} },
  });

  expect(result.stop.cause).toBe('done');
  expect(compactions.length).toBe(1);
  expect(summaries.length).toBe(1);
  mock.module('../src/tools/registry.ts', () => realRegistry);
});

test('접어서 줄어드는 한, 긴 턴에서는 창이 다시 찰 때마다 또 접는다', async () => {
  // tool 메시지 하나를 4,000토큰으로 센다. 8개면 접는 선(40,000 − 12,000)을 넘고, 최근 두
  // 라운드만 남기고 접으면 8,000으로 내려간다. 예전에는 한 턴에 한 번만 접어 그 뒤로는
  // 400으로 끝났다
  const realRegistry = { ...(await import('../src/tools/registry.ts')) };
  mock.module('../src/tools/registry.ts', () => ({
    ...realRegistry,
    dispatchTool: async () => ({ images: [], text: '내용' }),
  }));
  scriptedReads(30, messages => 4_000 * messages.filter(m => m.role === 'tool').length, 40_000);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const compactions: number[] = [];
  const live = { ...(session() as object), messages: [{ content: '다 읽어', role: 'user' }], sessionId: 'loop-s4' } as never;
  const result = await runAgentLoop(live, {
    allowTool: name => name === 'read_file',
    onCompact: () => compactions.push(1),
    output: { write() {} },
  });

  expect(result.stop.cause).toBe('done');
  expect(result.toolTurns.length).toBe(30);
  expect(compactions.length).toBeGreaterThanOrEqual(4);
  mock.module('../src/tools/registry.ts', () => realRegistry);
});

/**
 * vLLM처럼 입력과 출력 상한의 합이 창을 넘으면 생성 전에 거절하는 프로바이더.
 * 글자 1.6자를 1토큰으로 센다. underCount를 주면 루프의 실측은 그만큼 적게 센다
 * (도구 정의 어림 오차처럼 예방 판정이 빗나간 상황)
 */
function strictProvider({
  rounds = [],
  underCount = 1,
  window,
}: {
  /** 라운드마다 부를 도구. 다 쓰면 답을 끝낸다 */
  rounds?: { input: Record<string, unknown>; name: string }[];
  underCount?: number;
  window: number;
}) {
  const count = (messages: { content?: unknown }[]) =>
    Math.ceil(messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0) / 1.6);
  const sent: Sent[] = [];
  let answered = 0;
  mock.module('../src/providers/contextWindow.ts', () => ({
    ...realWindow,
    resolveContextWindow: () => window,
  }));
  mock.module('../src/providers/index.ts', () => ({
    ...realProviders,
    countProviderTokens: async (_session: unknown, messages: { content?: unknown }[]) =>
      Math.ceil(count(messages) * underCount),
    runProviderText: async () => '요약',
    runProviderTurn: async (session: Sent) => {
      sent.push({ maxTokens: session.maxTokens, messages: session.messages });
      const tokens = count(session.messages);
      if (tokens + session.maxTokens > window) {
        throw new ProviderRequestError({
          body: `This model's maximum context length is ${window} tokens. However, you requested ${tokens + session.maxTokens} tokens.`,
          message: 'vLLM 요청 실패 (400)',
          provider: 'vLLM',
          status: 400,
        });
      }
      const call = rounds[answered];
      answered += 1;
      if (!call) return { text: '끝', toolCalls: [], usage: undefined };
      return { text: '', toolCalls: [{ id: `t${answered}`, ...call }], usage: undefined };
    },
  }));
  return { count, sent };
}

const toolContents = (request: Sent) =>
  request.messages.filter(message => message.role === 'tool').map(message => String(message.content));

test('도구 결과 하나가 창의 4분의 1을 넘으면 앞뒤만 남겨 이력에 넣는다', async () => {
  // 문서 변환은 결과 크기 상한이 없어 1만 행 엑셀 하나가 262K 창의 세 배로 들어왔다.
  // 직전 라운드의 결과는 압축도 축약도 건드리지 않아 다음 요청이 거절되고 턴이 멈췄다
  const realRegistry = { ...(await import('../src/tools/registry.ts')) };
  mock.module('../src/tools/registry.ts', () => ({
    ...realRegistry,
    dispatchTool: async () => ({ images: [], text: '가'.repeat(300_000) }),
  }));
  const { sent } = strictProvider({
    rounds: [{ input: { path: 'dict.xlsx' }, name: 'parse_document' }],
    window: 40_000,
  });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const live = { ...(session() as object), messages: [{ content: '용어 사전 읽어 줘', role: 'user' }], sessionId: 'loop-s5' } as never;
  const result = await runAgentLoop(live, { allowTool: name => name === 'parse_document', output: { write() {} } });

  expect(result.stop.cause).toBe('done');
  // 40K 창의 4분의 1은 1만 6천 자 남짓이지만 파일 한 번 읽기(2만 자)보다 짧게는 자르지 않는다
  const stored = String(result.toolTurns[0].toolCalls?.[0].result);
  expect(stored).toContain('도구 결과 300000자 중 가운데 280000자 생략');
  expect(stored.length).toBeLessThan(20_400);
  expect(toolContents(sent[1])[0]).toBe(stored);
  mock.module('../src/tools/registry.ts', () => realRegistry);
});

test('직전 라운드에 창보다 큰 결과가 이미 들어 있어도 멈추지 않고 줄여서 보낸다', async () => {
  // 상한이 생기기 전에 세션에 저장된 결과. 오래된 결과만 줄이던 예전에는 직전 라운드라
  // 손대지 못해 두 번 다 거절되고 멈췄다
  const { count, sent } = strictProvider({ window: 100_000 });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const live = {
    ...(session() as object),
    messages: [
      { content: '용어 사전 읽어 줘', role: 'user' },
      { content: '', role: 'assistant', toolCalls: [{ id: 'p', input: { path: 'dict.xlsx' }, name: 'parse_document', ok: true, result: '가'.repeat(600_000) }] },
    ],
    sessionId: 'loop-s6',
  } as never;
  const result = await runAgentLoop(live, context);

  expect(result.stop.cause).toBe('done');
  expect(sent.length).toBe(1);
  expect(toolContents(sent[0])[0]).toContain('생략');
  // 접는 선(100,000 - 12,000) 아래로 맞춰 보냈다
  expect(count(sent[0].messages)).toBeLessThanOrEqual(88_000);
});

test('창을 넘겨 거절되면 직전 라운드의 결과도 줄이고 출력 상한도 좁혀 한 번 다시 보낸다', async () => {
  // 루프의 실측이 실제보다 10% 적게 센다. 예방 판정은 들어간다고 보고 보내지만
  // 실제로는 넘쳐 거절된다. 예전에는 오래된 결과만 줄여 같은 요청을 다시 보냈다
  const { count, sent } = strictProvider({ underCount: 0.9, window: 100_000 });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const live = {
    ...(session() as object),
    messages: [
      { content: '용어 사전 읽어 줘', role: 'user' },
      { content: '', role: 'assistant', toolCalls: [{ id: 'p', input: { path: 'dict.xlsx' }, name: 'parse_document', ok: true, result: '가'.repeat(130_000) }] },
    ],
    sessionId: 'loop-s7',
  } as never;
  const result = await runAgentLoop(live, context);

  expect(result.stop.cause).toBe('done');
  expect(sent.length).toBe(2);
  expect(toolContents(sent[0])[0]).toBe('가'.repeat(130_000));
  expect(toolContents(sent[1])[0]).toContain('생략');
  // 다시 보낼 때는 출력 상한을 접는 선이 남겨 두는 자리(12,000)까지만 준다
  expect(sent[1].maxTokens).toBeLessThanOrEqual(12_000);
  expect(count(sent[1].messages) + sent[1].maxTokens).toBeLessThanOrEqual(100_000);
});
