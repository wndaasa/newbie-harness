// 프로바이더 재시도 회귀 테스트.
//
// 에이전트 루프는 한 번 시키면 요청을 열댓 번 연속으로 쏜다. 그래서 429는 예외가
// 아니라 일상인데, 예전에는 그 자리에서 턴을 죽였다. 실제로 웹페이지 하나 만드는
// 도중 429가 나서 작업이 통째로 날아간 적이 있다 — 그때 API는 "5.486초 뒤에 다시
// 시도해라"라고 알려주고 있었다.

import { describe, expect, test } from 'bun:test';
import {
  fetchWithRetry,
  isRetryableStatus,
  rateLimitWaitMs,
  resolveWaitMs,
} from '../src/providers/fetchWithRetry.ts';

const RATE_LIMIT_BODY = JSON.stringify({
  error: {
    code: 'rate_limit_exceeded',
    message:
      'Rate limit reached for gpt-5.6-luna in organization org-x on tokens per min (TPM): Limit 200000, Used 200000, Requested 18289. Please try again in 5.486s.',
    type: 'tokens',
  },
});

function response(status: number, body = '', headers: Record<string, string> = {}) {
  return new Response(body, { headers, status });
}

describe('대기 시간 판정', () => {
  test('Retry-After 헤더(초)를 쓴다', () => {
    expect(resolveWaitMs(new Headers({ 'retry-after': '3' }), '', 1)).toBe(3000);
  });

  test('헤더가 없으면 본문의 안내를 읽는다', () => {
    // OpenAI는 헤더 없이 본문으로만 알려주는 경우가 있다
    expect(resolveWaitMs(new Headers(), RATE_LIMIT_BODY, 1)).toBe(5486);
  });

  test('ms 단위 안내도 읽는다', () => {
    expect(resolveWaitMs(new Headers(), 'Please try again in 800ms', 1)).toBe(800);
  });

  test('아무 안내도 없으면 지수 백오프', () => {
    expect(resolveWaitMs(new Headers(), '', 1)).toBe(1000);
    expect(resolveWaitMs(new Headers(), '', 2)).toBe(2000);
    expect(resolveWaitMs(new Headers(), '', 3)).toBe(4000);
    // 무한정 늘어나지 않는다
    expect(resolveWaitMs(new Headers(), '', 9)).toBe(8000);
  });
});

describe('스트림 한도 오류 판정', () => {
  // 한도 오류는 HTTP 429만이 아니라 200 스트림의 SSE error 이벤트로도 온다.
  // 그 메시지로 재시도 여부와 대기 시간을 정한다
  test('한도 오류 메시지에서 대기 시간을 읽는다', () => {
    expect(
      rateLimitWaitMs('Rate limit reached for gpt-5.6 on tokens per min (TPM). Please try again in 5.102s.'),
    ).toBe(5102);
  });

  test('대기 안내가 없으면 기본값으로 기다린다', () => {
    expect(rateLimitWaitMs('Rate limit reached, slow down')).toBe(5000);
  });

  test('한도 오류가 아니면 재시도하지 않는다', () => {
    expect(rateLimitWaitMs('invalid api key')).toBeUndefined();
    expect(rateLimitWaitMs('context length exceeded')).toBeUndefined();
  });
});

describe('재시도 대상', () => {
  test('한도·일시 장애는 다시 시도한다', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  test('요청이 잘못된 건 다시 보내도 소용없다', () => {
    // 400(형식 오류)·401(키 오류)·404를 재시도하면 같은 실패만 반복한다
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe('재시도 동작', () => {
  test('429 뒤에 성공하면 그 응답을 돌려준다', async () => {
    const calls: number[] = [];
    const original = globalThis.fetch;
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt += 1;
      calls.push(attempt);
      return attempt === 1
        ? response(429, 'Please try again in 10ms')
        : response(200, 'ok');
    }) as unknown as typeof fetch;

    try {
      const result = await fetchWithRetry('https://example.com', {}, { label: 'Test' });
      expect(await result.text()).toBe('ok');
      expect(calls).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('재시도할 때 이유를 알린다', async () => {
    // 알리지 않으면 화면이 멈춘 것처럼 보인다
    const notices: number[] = [];
    const original = globalThis.fetch;
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt += 1;
      return attempt === 1 ? response(429, 'try again in 10ms') : response(200, 'ok');
    }) as unknown as typeof fetch;

    try {
      await fetchWithRetry(
        'https://example.com',
        {},
        { label: 'Test', onRetry: notice => notices.push(notice.status) },
      );
      expect(notices).toEqual([429]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('재시도 대상이 아니면 바로 실패한다', async () => {
    const original = globalThis.fetch;
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt += 1;
      return response(401, 'invalid api key');
    }) as unknown as typeof fetch;

    try {
      await expect(
        fetchWithRetry('https://example.com', {}, { label: 'Test' }),
      ).rejects.toThrow(/401/);
      expect(attempt).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('끝까지 실패하면 시도 횟수를 알린다', async () => {
    const original = globalThis.fetch;
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt += 1;
      return response(429, 'try again in 1ms');
    }) as unknown as typeof fetch;

    try {
      // 429는 시간이 지나면 반드시 풀리므로 5xx(4회)보다 끈질기게 기다린다
      await expect(
        fetchWithRetry('https://example.com', {}, { label: 'Test' }),
      ).rejects.toThrow(/10회 시도/);
      expect(attempt).toBe(10);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('5xx는 예전 상한(4회)을 유지한다', async () => {
    // 서버 장애는 시간이 해결해 준다는 보장이 없다 — 오래 붙잡지 않는다
    const original = globalThis.fetch;
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt += 1;
      return response(503, 'try again in 1ms');
    }) as unknown as typeof fetch;

    try {
      await expect(
        fetchWithRetry('https://example.com', {}, { label: 'Test' }),
      ).rejects.toThrow(/4회 시도/);
      expect(attempt).toBe(4);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('대기 시간이 지나치게 길면 기다리지 않는다', async () => {
    // 5분 뒤에 풀린다면 붙잡고 있는 것보다 알려주는 편이 낫다
    const original = globalThis.fetch;
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt += 1;
      return response(429, '', { 'retry-after': '300' });
    }) as unknown as typeof fetch;

    try {
      await expect(
        fetchWithRetry('https://example.com', {}, { label: 'Test' }),
      ).rejects.toThrow(/429/);
      expect(attempt).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
