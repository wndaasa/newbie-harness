// 압축 체크포인트 회귀 테스트.
//
// 예전에는 압축이 턴 안에서만 살아서, 40K 창에서 임계를 넘은 뒤로는 매 턴 요약을
// 다시 만들고 알림이 매번 떴다. 여기서 고정하는 것은 "한 번 접으면 세션에 남은
// 자리에서 모델 호출 없이 이어가고, 접힌 뒤 구간이 다시 찰 때만 이전 요약을
// 이어받아 새로 접는다"이다.

import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { SessionModelMessage } from '../src/session/storage.ts';

const realProviders = { ...(await import('../src/providers/index.ts')) };
afterAll(() => {
  mock.module('../src/providers/index.ts', () => realProviders);
});

/** 요약 호출을 세면서 고정 문장을 돌려주는 프로바이더 */
function summarizer() {
  const calls: string[] = [];
  mock.module('../src/providers/index.ts', () => ({
    ...realProviders,
    runProviderText: async (_session: unknown, options: { messages: { content: string }[] }) => {
      calls.push(options.messages[0].content);
      return `요약 ${calls.length}`;
    },
  }));
  return calls;
}

function user(content: string): SessionModelMessage {
  return { content, role: 'user' };
}
function assistant(content: string): SessionModelMessage {
  return { content, role: 'assistant' };
}
function history(from: number, to: number): SessionModelMessage[] {
  const messages: SessionModelMessage[] = [];
  for (let i = from; i <= to; i += 1) messages.push(user(`요청 ${i}`), assistant(`답변 ${i}`));
  return messages;
}

const session = { sessionId: 's1' } as never;

describe('압축 체크포인트', () => {
  test('세션에 남은 접힌 자리로 다음 턴을 모델 호출 없이 재구성한다', async () => {
    const calls = summarizer();
    const { applyCompactionCheckpoint, compactMessages } = await import('../src/agent/compact.ts');

    const stored = history(1, 8);
    const first = await compactMessages(session, stored, { keepTurns: 2 });
    expect(first.compacted).toBe(true);
    // 컨트롤러가 하는 일: 접힌 마지막 메시지의 자리를 인덱스로 바꿔 세션에 둔다
    const foldedCount = stored.indexOf(first.checkpoint!.lastFolded) + 1;
    expect(foldedCount).toBe(12);

    // 다음 턴: 세션에 새 요청이 붙었다
    stored.push(user('요청 9'));
    const rebuilt = applyCompactionCheckpoint(stored, {
      foldedCount,
      prompts: first.checkpoint!.prompts,
      summary: first.checkpoint!.summary,
    });

    // 머리 두 건(요약·확인) + 접히지 않은 뒤 구간. 요약 호출은 처음 한 번뿐이다
    expect(rebuilt[0].content).toContain('요약 1');
    expect(rebuilt[0].content).toContain('1. 요청 1');
    expect(rebuilt[2]).toEqual(user('요청 7'));
    expect(rebuilt.at(-1)).toEqual(user('요청 9'));
    expect(calls.length).toBe(1);
  });

  test('접힌 뒤 구간이 다시 차면 이전 요약을 이어받아 새로 접는다', async () => {
    const calls = summarizer();
    const { applyCompactionCheckpoint, compactMessages } = await import('../src/agent/compact.ts');

    const stored = history(1, 8);
    const first = await compactMessages(session, stored, { keepTurns: 2 });
    const folded = {
      foldedCount: stored.indexOf(first.checkpoint!.lastFolded) + 1,
      prompts: first.checkpoint!.prompts,
      summary: first.checkpoint!.summary,
    };
    stored.push(...history(9, 14));
    const rebuilt = applyCompactionCheckpoint(stored, folded);

    const second = await compactMessages(session, rebuilt, { checkpoint: folded, keepTurns: 2 });

    expect(second.compacted).toBe(true);
    // 요청 원문 목록은 그대로 이어 붙는다 — 요약의 요약이 돼도 사용자가 건 제약은 남는다
    expect(second.checkpoint!.prompts).toEqual(
      ['요청 1', '요청 2', '요청 3', '요청 4', '요청 5', '요청 6', '요청 7', '요청 8', '요청 9', '요청 10', '요청 11', '요청 12'],
    );
    // 새 요약 요청은 접힌 머리(이전 요약이 든 압축문)부터 대화 전체를 본다
    expect(calls[1]).toContain('## 지금까지의 요약');
    expect(calls[1]).toContain('요약 1');
    expect(second.messages[0].content).toContain('요약 2');
    expect(second.messages[2]).toEqual(user('요청 13'));
    // 새로 접힌 자리는 세션 이력 안의 객체다 — 컨트롤러가 인덱스로 바꿀 수 있다
    expect(stored.indexOf(second.checkpoint!.lastFolded)).toBe(23);
  });

  test('접힌 수가 이력보다 크면 맞지 않는 값이라 접지 않은 것으로 본다', async () => {
    const { applyCompactionCheckpoint } = await import('../src/agent/compact.ts');
    const messages = history(1, 2);

    const rebuilt = applyCompactionCheckpoint(messages, { foldedCount: 99, prompts: [], summary: 'x' });

    expect(rebuilt).toEqual(messages);
    expect(rebuilt).not.toBe(messages);
  });

  test('요약에 실패하면 이전 요약을 유지한다', async () => {
    mock.module('../src/providers/index.ts', () => ({
      ...realProviders,
      runProviderText: async () => {
        throw new Error('요약 실패');
      },
    }));
    const { compactMessages } = await import('../src/agent/compact.ts');

    const checkpoint = { prompts: ['요청 0'], summary: '살아남을 요약' };
    const rebuilt = [user('brief'), assistant('ack'), ...history(1, 6)];
    const result = await compactMessages(session, rebuilt, { checkpoint, keepTurns: 2 });

    expect(result.compacted).toBe(true);
    expect(result.checkpoint!.summary).toBe('살아남을 요약');
    expect(result.checkpoint!.prompts[0]).toBe('요청 0');
  });

  // 예전 요약기는 대화를 글로 풀어 2만 자까지만 봤고 도구 결과는 이름만 봤다
  test('요약은 도구 결과까지 든 대화 전체를 본 요청과 같은 시스템 프롬프트와 도구로 요청한다', async () => {
    const seen: { keepReasoning?: boolean; messages: { content?: unknown; role: string }[]; systemPrompt?: string; tools?: unknown[] }[] = [];
    mock.module('../src/providers/index.ts', () => ({
      ...realProviders,
      runProviderText: async (_session: unknown, options: (typeof seen)[number]) => {
        seen.push(options);
        return '1. 요청과 의도: 로그인 복구';
      },
    }));
    const { compactMessages } = await import('../src/agent/compact.ts');
    const round = (id: string, result: string): SessionModelMessage => ({
      content: '',
      role: 'assistant',
      toolCalls: [{ id, input: { command: id }, name: 'run_command', ok: true, result }],
    });
    const messages = [
      user('8081 로그인 원인 찾아 줘'),
      round('a', 'Keycloak 18080 LISTENING 없음'),
      round('b', '둘째 결과'),
      round('c', '셋째 결과'),
    ];
    const tools = [{ name: 'run_command' }];

    const result = await compactMessages({ provider: 'vllm', sessionId: 's1' } as never, messages, {
      contextWindow: 262_144,
      keepToolRounds: 2,
      systemPrompt: '본 요청의 시스템 프롬프트',
      tools,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].systemPrompt).toBe('본 요청의 시스템 프롬프트');
    expect(seen[0].tools).toBe(tools);
    expect(seen[0].keepReasoning).toBe(true);
    const sent = seen[0].messages.map(message => String(message.content ?? ''));
    expect(sent.some(text => text.includes('Keycloak 18080 LISTENING 없음'))).toBe(true);
    expect(sent.at(-1)).toContain('[요약 요청');
    // 압축문 전체(요약과 요청 원문 목록)를 화면이 펼쳐 볼 수 있게 돌려준다
    expect(result.brief).toContain('1. 요청과 의도: 로그인 복구');
    expect(result.brief).toContain('1. 8081 로그인 원인 찾아 줘');
  });

  test('요약 요청이 창을 넘으면 도구 결과의 가운데를 덜어 창 안으로 보낸다', async () => {
    // 접는 시점의 이력은 이미 접는 선을 넘겼고, 요약 출력 자리까지 더하면 창을 넘기기
    // 쉽다. 넘기면 거절되어 옛 방식(메시지당 1,200자 발췌)으로 떨어졌다
    const seen: { maxTokens?: number; messages: { content?: unknown }[] }[] = [];
    mock.module('../src/providers/index.ts', () => ({
      ...realProviders,
      // 셀 수 없는 제공자로 두어 글자 수 어림(1.6자/토큰)으로 잰다
      countProviderTokens: async () => null,
      runProviderText: async (_session: unknown, options: (typeof seen)[number]) => {
        seen.push(options);
        return '1. 요청과 의도: 용어 사전 정리';
      },
    }));
    const { compactMessages } = await import('../src/agent/compact.ts');
    const round = (id: string, result: string): SessionModelMessage => ({
      content: '',
      role: 'assistant',
      toolCalls: [{ id, input: { path: id }, name: 'parse_document', ok: true, result }],
    });
    const messages = [
      user('용어 사전대로 이름 붙여 줘'),
      round('a', 'Keycloak 18080 LISTENING 없음'),
      round('b', '가'.repeat(200_000)),
      round('c', '셋째 결과'),
      round('d', '넷째 결과'),
    ];

    const result = await compactMessages({ provider: 'vllm', sessionId: 's1' } as never, messages, {
      contextWindow: 40_000,
      keepToolRounds: 2,
      tools: [],
    });

    expect(result.checkpoint!.summary).toBe('1. 요청과 의도: 용어 사전 정리');
    expect(seen).toHaveLength(1);
    const sent = seen[0].messages.map(message => String(message.content ?? ''));
    // 짧은 결과는 그대로, 긴 결과만 가운데를 덜어 냈다
    expect(sent.some(text => text === 'Keycloak 18080 LISTENING 없음')).toBe(true);
    expect(sent.some(text => text.includes('생략'))).toBe(true);
    // 요약 출력 자리를 빼고 창 안에 든다
    const tokens = Math.ceil(sent.reduce((sum, text) => sum + text.length, 0) / 1.6);
    expect(tokens + seen[0].maxTokens!).toBeLessThanOrEqual(40_000);
  });

  test('대화 전체로 요약하지 못하면 대화를 글로 풀어 넘기는 옛 방식으로 요약한다', async () => {
    const seen: string[] = [];
    mock.module('../src/providers/index.ts', () => ({
      ...realProviders,
      runProviderText: async (_session: unknown, options: { messages: { content: string }[] }) => {
        seen.push(options.messages.at(-1)!.content);
        if (seen.length === 1) throw new Error('context length');
        return '옛 방식 요약';
      },
    }));
    const { compactMessages } = await import('../src/agent/compact.ts');

    const result = await compactMessages(session, history(1, 6), { keepTurns: 2 });

    expect(result.checkpoint!.summary).toBe('옛 방식 요약');
    expect(seen[1]).toContain('--- 대화 ---');
  });
});
