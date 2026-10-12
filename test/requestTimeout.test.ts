// 프로바이더 요청의 무응답 감시 회귀 테스트.
//
// 예전에는 요청 시작부터 5분을 절대 상한으로 걸어서, 큰 컨텍스트에 사고를 켠
// 모델이 토큰을 멀쩡히 흘려보내는 중에도 5분이 되면 턴이 죽었다. 감시는
// "마지막 청크 이후 얼마나 조용했나"만 봐야 한다.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fetchWithRetry } from '../src/providers/fetchWithRetry.ts';

const LIMIT_MS = 60;
const originalFetch = globalThis.fetch;
const originalLimit = process.env.NEWBIE_REQUEST_TIMEOUT_MS;

beforeEach(() => {
  process.env.NEWBIE_REQUEST_TIMEOUT_MS = String(LIMIT_MS);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLimit === undefined) delete process.env.NEWBIE_REQUEST_TIMEOUT_MS;
  else process.env.NEWBIE_REQUEST_TIMEOUT_MS = originalLimit;
});

/** 청크를 주어진 간격으로 흘려보내는 본문. gaps가 끝나면 닫히거나(close) 영영 조용해진다 */
function slowBody(gapsMs: number[], close = true): ReadableStream<Uint8Array> {
  // 취소된 뒤 타이머가 enqueue를 시도하면 타이머 콜백에서 예외가 나 다른 테스트
  // 파일까지 흔든다. 취소를 기억해 두고 그 뒤 타이머는 아무것도 하지 않는다
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(ctl) {
      let at = 0;
      for (const gap of gapsMs) {
        at += gap;
        setTimeout(() => {
          if (!cancelled) ctl.enqueue(new TextEncoder().encode('a'));
        }, at);
      }
      if (close) setTimeout(() => ctl.close(), at + 1);
    },
    cancel() {
      cancelled = true;
    },
  });
}

function mockFetch(handler: (init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((_url: string, init?: RequestInit) => handler(init)) as unknown as typeof fetch;
}

describe('무응답 감시', () => {
  test('절대 상한이 아니다 — 청크가 계속 오면 전체 시간이 상한을 넘어도 끊지 않는다', async () => {
    mockFetch(async () => new Response(slowBody([20, 20, 20, 20, 20])));
    const response = await fetchWithRetry('https://example.com', {}, { label: 'Test' });
    // 총 100ms > 60ms 상한. 예전 방식이면 여기서 TimeoutError가 났다
    expect(await response.text()).toBe('aaaaa');
  });

  test('청크 사이가 상한을 넘으면 끊는다', async () => {
    mockFetch(async () => new Response(slowBody([10], false)));
    const response = await fetchWithRetry('https://example.com', {}, { label: 'Test' });
    const error = await response.text().then(() => null, (e: unknown) => e as Error);
    expect(error?.name).toBe('TimeoutError');
    expect(error?.message).toContain('응답이 없어');
  });

  test('응답이 시작되지 않아도 끊는다', async () => {
    mockFetch(init => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const error = await fetchWithRetry('https://example.com', {}, { label: 'Test' })
      .then(() => null, (e: unknown) => e as Error);
    expect(error?.name).toBe('TimeoutError');
  });

  test('사용자 중단은 그대로 전달된다', async () => {
    const user = new AbortController();
    mockFetch(async () => new Response(slowBody([10, 10, 10], false)));
    const response = await fetchWithRetry('https://example.com', {}, { label: 'Test', signal: user.signal });
    setTimeout(() => user.abort(), 15);
    const error = await response.text().then(() => null, (e: unknown) => e as Error);
    expect(error?.name).toBe('AbortError');
  });
});
