// 대화 이력 압축 회귀 테스트.
//
// 지금까지는 이력 전체가 매 턴 나갔다. 클라우드 모델은 창이 20만이라 좀처럼
// 차지 않았지만 로컬 모델(vLLM Qwen3-8B는 40,960)에서는 몇 턴 만에 닿고,
// 닿으면 400으로 죽었다. 여기서 고정하는 것은 "무엇을 남기는가"다 —
// 사용자가 직접 친 프롬프트는 전부, 오래된 구간은 요약, 최근 몇 턴은 원문.

import { describe, expect, test } from 'bun:test';
import {
  OUTPUT_RESERVE_TOKENS,
  buildCompactionBrief,
  collectUserPrompts,
  compactThreshold,
  estimateTokens,
  fitPromptsToBudget,
  promptBudgetChars,
  shouldCompact,
  buildSummarySource,
  splitForCompaction,
  splitForFold,
  summaryBudgetTokens,
  trimToolResultsForSend,
} from '../src/agent/compact.ts';
import type { SessionModelMessage } from '../src/session/storage.ts';

function user(content: string, extra: Partial<SessionModelMessage> = {}): SessionModelMessage {
  return { content, role: 'user', ...extra };
}
function assistant(content: string, extra: Partial<SessionModelMessage> = {}): SessionModelMessage {
  return { content, role: 'assistant', ...extra };
}

/** 사용자 턴 n개짜리 이력 */
function history(turns: number): SessionModelMessage[] {
  const messages: SessionModelMessage[] = [];
  for (let i = 1; i <= turns; i += 1) {
    messages.push(user(`요청 ${i}`));
    messages.push(assistant(`답변 ${i}`));
  }
  return messages;
}

describe('압축 판정', () => {
  test('큰 창은 요약 요청이 들어갈 자리만 남기고 90% 부근에서 접는다', () => {
    // 예전에는 70%에서 접어 한 번에 비우는 양이 적고 자주 접었다
    expect(compactThreshold(262_144)).toBe(262_144 - 26_215);
    expect(shouldCompact(200_000, 262_144)).toBe(false);
    expect(shouldCompact(240_000, 262_144)).toBe(true);
  });

  test('작은 창은 최소 여유(12,000)를 남긴다', () => {
    // 41K 창이면 예전과 비슷한 70% 부근이다. 한 라운드에 들어오는 양에 비해 여유가 적다
    expect(compactThreshold(40_960)).toBe(28_960);
    expect(shouldCompact(28_000, 40_960)).toBe(false);
    expect(shouldCompact(29_000, 40_960)).toBe(true);
  });

  test('출력 자리가 안 남는 상황은 늘 접는 쪽이다', () => {
    // 남겨 두는 자리가 출력 예약분보다 넓어, "아직 여유 있다"고 판단한 채로 요청이 죽지 않는다
    const window = 40_960;
    expect(shouldCompact(window - OUTPUT_RESERVE_TOKENS + 1, window)).toBe(true);
  });

  test('한국어를 적게 세지 않는다', () => {
    // 예전 기본값 2.5는 한국어(실측 1.48자/토큰)를 1.7배 적게 세서, 창이 다
    // 찼는데도 압축이 걸리지 않았다
    const korean = [user('가'.repeat(40_000))];
    expect(estimateTokens(korean)).toBeGreaterThan(20_000);
  });

  test('창을 모르면 접지 않는다', () => {
    // 0으로 나눠 항상 참이 되면 대화가 시작하자마자 접힌다
    expect(shouldCompact(999_999, 0)).toBe(false);
  });

  test('실측 비율을 주면 그 비율로 센다', () => {
    const messages = [user('가'.repeat(1000))];
    // 같은 이력이라도 모델에 따라 토큰 수가 다르다
    expect(estimateTokens(messages, 2)).toBe(500);
    expect(estimateTokens(messages, 4)).toBe(250);
  });

  test('도구 호출 분량도 센다', () => {
    const withTool = [assistant('했습니다', { toolCalls: [{ name: 'read_file' } as never] })];
    // 도구 결과가 이력의 대부분을 차지하는 일이 흔하다. 빼고 세면 한참 늦게 접는다
    expect(estimateTokens(withTool)).toBeGreaterThan(estimateTokens([assistant('했습니다')]));
  });
});

describe('무엇을 남기는가', () => {
  test('최근 N턴은 원문으로 남긴다', () => {
    const { older, recent } = splitForCompaction(history(10), 4);

    expect(recent[0]).toEqual(user('요청 7'));
    expect(recent.at(-1)).toEqual(assistant('답변 10'));
    expect(older.at(-1)).toEqual(assistant('답변 6'));
  });

  test('턴 수가 적으면 아무것도 접지 않는다', () => {
    const messages = history(3);
    const { older, recent } = splitForCompaction(messages, 4);

    expect(older).toEqual([]);
    expect(recent).toBe(messages);
  });

  test('끼어든 메시지는 새 턴으로 세지 않는다', () => {
    const messages = [
      user('요청 1'),
      assistant('답변 1'),
      user('요청 2'),
      user('아 그리고 이것도', { interjected: true }),
      assistant('답변 2'),
    ];

    // 끼어든 메시지를 경계로 삼으면 진행 중이던 턴이 중간에서 잘린다
    const { recent } = splitForCompaction(messages, 1);
    expect(recent[0]).toEqual(user('요청 2'));
  });

  test('사용자 프롬프트만 시간순으로 모은다', () => {
    const messages = [
      user('첫 요청'),
      assistant('네', { toolCalls: [{ name: 'read_file' } as never] }),
      user('둘째 요청'),
    ];

    // 도구 결과·파일 내용은 assistant의 toolCalls에 있어 섞이지 않는다
    expect(collectUserPrompts(messages)).toEqual(['첫 요청', '둘째 요청']);
  });

  test('요청은 모을 때 자르지 않는다 (길이는 압축문을 만들 때 예산에 맞춘다)', () => {
    const long = '문'.repeat(5_000);
    expect(collectUserPrompts([user(long)])).toEqual([long]);
  });

  test('빈 메시지는 목록에 넣지 않는다', () => {
    expect(collectUserPrompts([user('   '), user('진짜 요청')])).toEqual(['진짜 요청']);
  });
});

describe('요청 원문 예산', () => {
  test('예산 안이면 전부 원문 그대로 둔다', () => {
    const prompts = ['띠 넣지 마', '최소 수정만', '문'.repeat(3_000)];
    expect(fitPromptsToBudget(prompts, 10_000)).toBe(prompts);
  });

  test('넘치면 짧은 요청은 그대로 두고 긴 요청만 앞뒤를 남기고 줄인다', () => {
    const paste = `앞머리${'로그'.repeat(5_000)}결론줄`;
    const fitted = fitPromptsToBudget(['띠 넣지 마', '최소 수정만', paste], 2_000);

    expect(fitted[0]).toBe('띠 넣지 마');
    expect(fitted[1]).toBe('최소 수정만');
    // 붙여 넣은 로그는 앞과 끝이 남고, 몇 자였는지 알 수 있다
    expect(fitted[2].startsWith('앞머리')).toBe(true);
    expect(fitted[2].endsWith('결론줄')).toBe(true);
    expect(fitted[2]).toContain(`원문 ${paste.length}자`);
    expect(fitted[2].length).toBeLessThan(2_100);
  });

  test('줄여도 한 건이 너무 짧아지지는 않는다', () => {
    const prompts = Array.from({ length: 50 }, (_, index) => `${index}번 요청 `.repeat(200));
    const fitted = fitPromptsToBudget(prompts, 1_000);
    // 무엇을 시켰는지는 알아볼 수 있어야 한다 (예산을 넘기더라도 최소 분량은 남긴다)
    for (const prompt of fitted) expect(prompt.length).toBeGreaterThan(290);
  });

  test('예산은 창에 비례하고, 창을 모르면 최소 예산을 쓴다', () => {
    expect(promptBudgetChars(262_144)).toBeGreaterThan(20_000);
    expect(promptBudgetChars(0)).toBe(8_000);
  });

  test('요약 출력 예산은 접히는 양에 비례하고 2,000~8,000 사이다', () => {
    expect(summaryBudgetTokens(10_000)).toBe(2_000);
    expect(summaryBudgetTokens(100_000)).toBe(4_000);
    expect(summaryBudgetTokens(900_000)).toBe(8_000);
  });
});

describe('압축된 첫 메시지', () => {
  test('요약과 요청 원문을 함께 담는다', () => {
    const brief = buildCompactionBrief('- 설정창을 고쳤다', ['띠 넣지 마', '최소 수정만']);

    expect(brief).toContain('- 설정창을 고쳤다');
    expect(brief).toContain('1. 띠 넣지 마');
    expect(brief).toContain('2. 최소 수정만');
  });

  test('요약에 실패해도 요청 원문은 남는다', () => {
    const brief = buildCompactionBrief('', ['띠 넣지 마']);

    // 요약은 있으면 좋은 것이지, 없다고 사용자가 건 제약까지 버릴 이유는 아니다
    expect(brief).toContain('띠 넣지 마');
    expect(brief).not.toContain('## 지금까지의 요약');
  });
});

describe('보내는 사본의 도구 결과 축약', () => {
  const big = '내용'.repeat(500);
  function toolRound(id: string, result = big): SessionModelMessage {
    return assistant('', { toolCalls: [{ id, input: { path: id }, name: 'read_file', ok: true, result }] });
  }

  test('오래된 라운드의 결과만 줄이고 최근 라운드는 원문으로 둔다', () => {
    const messages = [user('요청'), toolRound('a'), toolRound('b'), toolRound('c'), toolRound('d')];

    const sent = trimToolResultsForSend(messages, 2);

    // 앞의 두 라운드는 줄고, 뒤의 두 라운드(모델이 지금 보고 있는 것)는 그대로
    expect(sent[1].toolCalls?.[0].result).toContain('생략');
    expect(sent[2].toolCalls?.[0].result).toContain('생략');
    expect(sent[3].toolCalls?.[0].result).toBe(big);
    expect(sent[4].toolCalls?.[0].result).toBe(big);
    // 호출과 결과의 짝은 유지된다
    expect(sent[1].toolCalls?.[0].id).toBe('a');
  });

  test('원본은 건드리지 않는다', () => {
    // 세션에 남는 원문이 줄어들면 대화를 다시 열었을 때 파일 내용이 사라진다
    const messages = [toolRound('a'), toolRound('b'), toolRound('c')];

    trimToolResultsForSend(messages, 1);

    expect(messages[0].toolCalls?.[0].result).toBe(big);
  });

  test('줄일 것이 없으면 원본을 그대로 돌려준다', () => {
    const few = [toolRound('a'), toolRound('b')];
    expect(trimToolResultsForSend(few, 2)).toBe(few);

    // 짧은 결과는 안내 문구가 원문만큼 길어 줄여도 이득이 없다
    const short = [toolRound('a', '짧은 결과'), toolRound('b'), toolRound('c')];
    expect(trimToolResultsForSend(short, 2)).toBe(short);
  });

  test('줄인 호출의 키를 알려 준다 — 다시 부르면 원문이 가야 한다', async () => {
    const { toolCallKey } = await import('../src/agent/compact.ts');
    const messages = [toolRound('a'), toolRound('b'), toolRound('c')];
    const stubbed = new Set<string>();

    trimToolResultsForSend(messages, 2, stubbed);

    expect([...stubbed]).toEqual([toolCallKey('read_file', { path: 'a' })]);
  });

  test('직전 한 라운드만 남기도록 좁힐 수 있다', () => {
    // 400을 받은 뒤의 복구 경로는 더 과감하게 줄인다
    const messages = [toolRound('a'), toolRound('b'), toolRound('c')];

    const sent = trimToolResultsForSend(messages, 1);

    expect(sent[0].toolCalls?.[0].result).toContain('생략');
    expect(sent[1].toolCalls?.[0].result).toContain('생략');
    expect(sent[2].toolCalls?.[0].result).toBe(big);
  });
});


describe('진행 중인 턴 안에서 접기', () => {
  const big = '내용'.repeat(300);
  const round = (id: string): SessionModelMessage =>
    assistant('', { toolCalls: [{ id, input: { path: id }, name: 'read_file', ok: true, result: big }] });
  // 요약 호출이 네트워크로 나가지 않게 모의 세션을 쓴다 (요약은 빈 문자열이 된다)
  const mockSession = { maxTokens: 1_000, mock: true, model: 'm', provider: 'mock' } as never;

  test('최근 N개의 도구 라운드와 그 뒤는 원문으로 두고 그 앞을 접는다', async () => {
    const turn = [user('다 읽어 줘'), round('a'), round('b'), user('c도', { interjected: true }), round('c'), assistant('다 읽었습니다')];

    const { older, recent } = splitForFold(turn, { keepToolRounds: 2 });

    expect(older).toEqual(turn.slice(0, 2));
    // 끼어든 메시지와 최종 답처럼 최근 라운드 사이와 뒤에 있는 것도 원문으로 남는다
    expect(recent).toEqual(turn.slice(2));
  });

  test('라운드가 N개 이하면 접지 않는다', async () => {
    const turn = [user('읽어 줘'), round('a'), round('b')];
    expect(splitForFold(turn, { keepToolRounds: 2 }).older).toEqual([]);
  });

  test('지난 턴과 진행 중인 턴의 오래된 라운드를 한 번에 접는다', async () => {
    const messages = [user('요청 1'), assistant('답변 1'), user('요청 2'), round('a'), round('b'), round('c')];
    const { older, recent } = splitForFold(messages, { keepToolRounds: 2 });
    expect(older).toEqual(messages.slice(0, 4));
    expect(recent).toEqual(messages.slice(4));
  });

  test('마지막 턴의 라운드가 적으면 턴 경계에서 가른다', async () => {
    const messages = [user('요청 1'), round('a'), round('b'), round('c'), user('요청 2'), round('d')];
    const { older, recent } = splitForFold(messages, { keepToolRounds: 2 });
    expect(older).toEqual(messages.slice(0, 4));
    expect(recent).toEqual(messages.slice(4));
  });

  test('접을 지난 턴이 없으면 진행 중인 턴의 오래된 라운드를 접고, 요청 원문은 목록에 남긴다', async () => {
    const { compactMessages } = await import('../src/agent/compact.ts');
    const turn = [user('로그인 원인 찾아 줘'), round('a'), round('b'), round('c')];

    // keepToolRounds 없이는 예전처럼 접을 것이 없다
    expect((await compactMessages(mockSession, turn)).compacted).toBe(false);

    const result = await compactMessages(mockSession, turn, { keepToolRounds: 2 });
    expect(result.compacted).toBe(true);
    expect(result.checkpoint?.prompts).toEqual(['로그인 원인 찾아 줘']);
    expect(result.checkpoint?.lastFolded).toBe(turn[1]);
    // 머리 뒤가 assistant 라운드라 "받았다" 한 줄 없이 요약 한 건만 붙는다
    expect(result.messages.map(m => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(result.messages.slice(1)).toEqual(turn.slice(2));
  });

  test('머리가 한 건인 이력도 다시 접을 때 머리를 재료로 쓰지 않는다', async () => {
    const { compactMessages } = await import('../src/agent/compact.ts');
    const turn = [user('원인 찾아 줘'), round('a'), round('b'), round('c')];
    const first = await compactMessages(mockSession, turn, { keepToolRounds: 2 });
    const grown = [...first.messages, round('d'), round('e')];

    const second = await compactMessages(mockSession, grown, {
      checkpoint: first.checkpoint,
      keepToolRounds: 2,
    });

    // 요청 목록은 이어받고, 접힌 머리의 안내문이 요청으로 섞여 들지 않는다
    expect(second.checkpoint?.prompts).toEqual(['원인 찾아 줘']);
    expect(second.messages.slice(1)).toEqual(grown.slice(-2));
  });

  test('루프가 넣은 재촉(automatic)은 턴의 시작도 요청 원문도 아니다', async () => {
    const { compactMessages, splitForCompaction } = await import('../src/agent/compact.ts');
    const nudge = user('[자동 알림 — 사용자가 보낸 메시지가 아닙니다.] 최근 3라운드 동안…', { automatic: true });
    const turn = [user('원인 찾아 줘'), round('a'), nudge, round('b'), round('c')];

    // 재촉을 턴의 시작으로 세면 진행 중인 턴이 재촉 자리에서 잘린다
    expect(splitForCompaction(turn, 1).older).toEqual([]);
    const result = await compactMessages(mockSession, turn, { keepToolRounds: 2 });
    expect(result.checkpoint?.prompts).toEqual(['원인 찾아 줘']);
  });

  test('세션에 남은 접힌 자리로 재구성할 때도 뒤따르는 메시지에 맞춰 머리를 붙인다', async () => {
    const { applyCompactionCheckpoint } = await import('../src/agent/compact.ts');
    const stored = [user('원인 찾아 줘'), round('a'), round('b'), round('c')];
    const compaction = { foldedCount: 2, prompts: ['원인 찾아 줘'], summary: '' };

    expect(applyCompactionCheckpoint(stored, compaction).map(m => m.role)).toEqual(['user', 'assistant', 'assistant']);
    // 뒤따르는 것이 사용자 메시지면 예전처럼 "받았다" 한 줄을 둔다
    const afterTurn = [...stored, user('다음 요청')];
    expect(applyCompactionCheckpoint(afterTurn, { ...compaction, foldedCount: 4 }).map(m => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });
});

describe('요약 재료', () => {
  test('도구 호출에 무엇을 읽었는지가 남는다', () => {
    const messages = [
      assistant('읽었습니다', {
        toolCalls: [
          { id: '1', input: { path: 'src/main/java/com/example/web/AdminController.java' }, name: 'read_file', ok: true, result: '...' },
          { id: '2', input: { query: '@RestController' }, name: 'search_files', ok: true, result: '...' },
        ],
      }),
    ];

    const source = buildSummarySource(messages);

    // 이름만 남기면 요약 모델이 파일명을 지어낸다 — 접힌 뒤 "처음 읽은 파일"을 틀리게 답한 사례
    expect(source).toContain('read_file(');
    expect(source).toContain('AdminController.java)');
    expect(source).toContain('search_files(@RestController)');
  });

  test('긴 경로는 파일명 쪽을 남긴다', () => {
    const long = `${'a/'.repeat(80)}Target.java`;
    const source = buildSummarySource([
      assistant('', { toolCalls: [{ id: '1', input: { path: long }, name: 'read_file', ok: true, result: '' }] }),
    ]);

    expect(source).toContain('Target.java)');
    expect(source).toContain('read_file(…');
  });

  test('인자가 없으면 이름만 적는다', () => {
    const source = buildSummarySource([assistant('', { toolCalls: [{ name: 'list_files' } as never] })]);
    expect(source).toContain('[도구: list_files]');
  });
});

describe('도구 결과 상한과 창 맞추기', () => {
  function toolRound(id: string, result: string): SessionModelMessage {
    return assistant('', { toolCalls: [{ id, input: { path: id }, name: 'read_file', ok: true, result }] });
  }

  test('결과 하나의 상한은 창의 4분의 1이고, 창이 작아도 파일 한 번 읽기만큼은 남긴다', async () => {
    const { toolResultCapChars } = await import('../src/agent/compact.ts');

    // 262K 창이면 6만 5천 토큰 남짓. 한국어 쪽에 맞춘 비율(1.6자/토큰)로 글자로 바꾼다
    expect(toolResultCapChars(262_144)).toBe(104_857);
    expect(toolResultCapChars(40_960)).toBe(20_000);
    expect(toolResultCapChars(0)).toBe(20_000);
  });

  test('상한을 넘는 결과는 앞뒤를 남기고, 무엇이 빠졌는지와 나머지를 보는 법을 적는다', async () => {
    const { clipToolResult } = await import('../src/agent/compact.ts');
    const text = `처음${'가'.repeat(50_000)}마지막`;

    const clipped = clipToolResult(text, 1_000);
    const [notice, head] = clipped.split('\n');

    // 생략했다는 안내가 맨 앞에 온다. 가운데에만 두면 모델이 지나치고 보이는 것으로 짐작한다
    expect(notice).toContain(`도구 결과 ${text.length}자 중 가운데 ${text.length - 1_000}자 생략`);
    expect(notice).toContain('다시 요청하세요');
    expect(head.startsWith('처음')).toBe(true);
    expect(clipped.endsWith('마지막')).toBe(true);
    expect(clipped.length).toBeLessThan(1_300);
    expect(clipToolResult('짧은 결과', 1_000)).toBe('짧은 결과');
  });

  test('예산에 맞출 때 짧은 결과는 그대로 두고 긴 결과부터 줄인다', async () => {
    const { fitToolResults, toolCallKey } = await import('../src/agent/compact.ts');
    const messages = [
      user('요청'),
      toolRound('a', '짧은 결과'),
      toolRound('b', '가'.repeat(50_000)),
      toolRound('c', '나'.repeat(3_000)),
    ];
    const stubbed = new Set<string>();

    const fitted = fitToolResults(messages, 10_000, stubbed);

    // 직전 라운드도 대상이다. 오래된 결과를 한 줄로 바꾸는 축약과 달리 지우지 않고 가운데만 덜어 낸다
    expect(fitted[1].toolCalls?.[0].result).toBe('짧은 결과');
    expect(fitted[3].toolCalls?.[0].result).toBe('나'.repeat(3_000));
    expect(fitted[2].toolCalls?.[0].result).toContain('생략');
    expect(String(fitted[2].toolCalls?.[0].result).length).toBeLessThan(7_300);
    // 줄인 호출은 "변화 없음" 비교에서 빠져야 한다
    expect([...stubbed]).toEqual([toolCallKey('read_file', { path: 'b' })]);
    // 원본은 그대로다
    expect(messages[2].toolCalls?.[0].result).toBe('가'.repeat(50_000));
    // 예산 안이면 원본을 그대로 돌려준다
    expect(fitToolResults(messages, 100_000)).toBe(messages);
  });

  test('목표 토큰 아래로 내려갈 때까지 재고 줄인다', async () => {
    const { fitHistoryToWindow } = await import('../src/agent/compact.ts');
    const messages = [user('읽어'), toolRound('a', '가'.repeat(400_000))];
    // 글자 1.6자를 1토큰으로 센다
    const measure = async (history: SessionModelMessage[]) =>
      Math.ceil(history.reduce((sum, message) => sum + String(message.toolCalls?.[0]?.result ?? message.content).length, 0) / 1.6);

    const fitted = await fitHistoryToWindow(messages, { keepRounds: 2, measure, targetTokens: 50_000 });

    expect(fitted.tokens).toBeLessThanOrEqual(50_000);
    expect(fitted.tokens).toBeGreaterThan(40_000);
    expect(fitted.history[1].toolCalls?.[0].result).toContain('생략');
  });

  test('이미 잰 값을 주면 줄일 것이 없을 때 다시 재지 않는다', async () => {
    const { fitHistoryToWindow } = await import('../src/agent/compact.ts');
    const messages = [user('읽어'), toolRound('a', '짧은 결과')];
    let measured = 0;

    const fitted = await fitHistoryToWindow(messages, {
      keepRounds: 2,
      measure: async () => {
        measured += 1;
        return 10;
      },
      targetTokens: 1_000,
      tokens: 10,
    });

    expect(measured).toBe(0);
    expect(fitted.history).toBe(messages);
  });
});
