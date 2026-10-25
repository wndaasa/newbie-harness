// Anthropic 캐시 표시 회귀 테스트.
//
// system·tools만 캐시하면 정작 가장 큰 대화 이력이 라운드마다 캐시 밖으로 나간다.
// Anthropic은 캐시에서 읽은 토큰을 분당 입력 한도(ITPM)에 세지 않으므로, 이력
// 캐시는 비용만이 아니라 한도 걸림 자체를 줄인다.

import { afterEach, describe, expect, test } from 'bun:test';
import { cacheMark, withHistoryCache } from '../src/providers/anthropic.ts';
import { ENV_CONTEXT_MARKER } from '../src/providers/types.ts';

const MARK = { type: 'ephemeral', ttl: '1h' } as const;

describe('캐시 수명', () => {
  afterEach(() => {
    delete process.env.NEWBIE_CACHE_TTL;
  });

  test('기본은 1시간이다 — 답을 읽고 다음 메시지를 쓰는 사이에 5분 캐시가 사라졌다', () => {
    expect(cacheMark()).toEqual(MARK);
  });

  test('NEWBIE_CACHE_TTL=5m이면 예전처럼 5분 캐시를 쓴다', () => {
    process.env.NEWBIE_CACHE_TTL = '5m';
    expect(cacheMark()).toEqual({ type: 'ephemeral' });
  });
});

describe('withHistoryCache', () => {
  test('마지막 메시지의 문자열 content를 블록으로 바꿔 캐시 표시를 단다', () => {
    const result = withHistoryCache([
      { role: 'user', content: '첫 질문' },
      { role: 'assistant', content: '답' },
      { role: 'user', content: '다음 질문' },
    ]);

    // 앞 메시지는 그대로 둔다 — 캐시 구간 판정은 표시 지점까지의 접두사 일치다
    expect(result[0]).toEqual({ role: 'user', content: '첫 질문' });
    expect(result.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '다음 질문', cache_control: MARK }],
    });
  });

  test('블록 배열 content는 마지막 블록에만 단다', () => {
    const result = withHistoryCache([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64' } },
          { type: 'text', text: '이거 봐줘' },
        ],
      },
    ]);

    const content = result[0].content as Record<string, unknown>[];
    expect(content[0]).not.toHaveProperty('cache_control');
    expect(content[1]).toEqual({
      type: 'text',
      text: '이거 봐줘',
      cache_control: MARK,
    });
  });

  test('빈 content는 그대로 둔다 — 빈 텍스트 블록은 API가 거부한다', () => {
    const messages = [{ role: 'user', content: '' }];
    expect(withHistoryCache(messages)).toEqual(messages);
  });

  test('빈 이력은 그대로 둔다', () => {
    expect(withHistoryCache([])).toEqual([]);
  });

  test('맨 끝이 환경 정보면 그 바로 앞 메시지에 단다', () => {
    // 환경 정보는 매 요청 새로 붙는다. 거기에 달면 다음 라운드의 같은 자리에는 다른
    // 메시지가 와서 이력 캐시가 한 번도 읽히지 않는다
    const env = { role: 'user', content: `${ENV_CONTEXT_MARKER}\n시각: 10:00` };
    const result = withHistoryCache([
      { role: 'user', content: '질문' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '결과' }] },
      env,
    ]);

    expect(result.at(-1)).toEqual(env);
    expect(result[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: '결과', cache_control: MARK },
      ],
    });
    // 한 요청의 표시는 4개까지다. 이력 쪽은 하나만 쓴다
    const marks = JSON.stringify(result).match(/cache_control/g) ?? [];
    expect(marks.length).toBe(1);
  });

  test('다음 라운드에서도 앞서 표시한 자리까지의 접두사가 같다', () => {
    const env = (time: string) => ({ role: 'user', content: `${ENV_CONTEXT_MARKER}\n${time}` });
    const history = [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '답' },
    ];
    const first = withHistoryCache([...history, env('10:00')]);
    const second = withHistoryCache([
      ...history,
      { role: 'user', content: '다음 질문' },
      env('10:01'),
    ]);
    // 첫 라운드가 표시한 메시지는 둘째 라운드에서 표시만 빠진 같은 내용이다
    expect(first[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '답', cache_control: MARK }],
    });
    expect(second[1]).toEqual(history[1]);
    expect(second[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '다음 질문', cache_control: MARK }],
    });
  });
});
