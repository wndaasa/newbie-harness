// 프로바이더 요청의 일시적 실패를 기다렸다 다시 보낸다.
//
// 에이전트 루프는 한 번 시키면 요청을 열댓 번 연속으로 쏜다. 그래서 분당 토큰
// 한도(429)에 걸리는 건 예외가 아니라 일상이다. 실제로 웹페이지 하나 만드는
// 도중에 걸려서 턴이 통째로 죽은 적이 있는데, 그때 API는 "5.486초 뒤에 다시
// 시도해라"라고 알려주고 있었다. 그걸 무시하고 실패로 다룬 게 문제였다.
//
// 여기서 기다렸다 재시도하면 사용자는 잠깐 멈춘 것 말고는 아무것도 겪지 않는다.

import { requestGuard } from './requestSignal.ts';

/** 기다렸다 다시 보낼 상태 코드. 429는 한도, 5xx는 서버 쪽 일시 장애 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const MAX_ATTEMPTS = 4;
/**
 * 429 전용 시도 상한. 분당 한도는 시간이 지나면 반드시 풀리므로 5xx보다 훨씬
 * 끈질기게 기다린다 — 4회(20초 남짓)로는 큰 컨텍스트가 한도 창을 비울 때까지
 * 못 기다려서 실제로 턴이 죽었다. 대신 누적 대기에 상한을 둬 영영 매달리지 않는다.
 */
const MAX_RATE_LIMIT_ATTEMPTS = 10;
const MAX_TOTAL_RATE_LIMIT_WAIT_MS = 120_000;
/** 서버가 알려준 대기 시간이 이보다 길면 기다리지 않고 실패로 알린다 */
const MAX_WAIT_MS = 60_000;
/**
 * 오류 메시지에 싣는 본문 상한. 메시지는 화면과 로그에 그대로 찍히는데, 프록시나
 * 게이트웨이가 HTML 오류 페이지 전체를 돌려주면 그 전부가 찍힌다. 분류용 원문은 body에 남는다
 */
const MAX_MESSAGE_BODY_CHARS = 2_000;

export type RetryNotice = {
  attempt: number;
  maxAttempts: number;
  status: number;
  waitMs: number;
};

/**
 * 응답이 실패로 끝났을 때 던지는 오류.
 *
 * message는 예전과 같은 문장이라 그냥 찍어도 동작이 달라지지 않는다. 상태와
 * 본문을 따로 실어 두는 건 화면 쪽에서 오류를 분류하기 위해서다 — 한국어로
 * 조립된 문장을 다시 파싱하면 문구를 손볼 때마다 분류가 조용히 깨진다.
 */
export class ProviderRequestError extends Error {
  readonly status: number;
  readonly body: string;
  readonly provider: string;

  constructor(options: { body: string; message: string; provider: string; status: number }) {
    super(options.message);
    this.name = 'ProviderRequestError';
    this.body = options.body;
    this.provider = options.provider;
    this.status = options.status;
  }
}

export type FetchWithRetryOptions = {
  /** 오류 메시지에 붙일 이름 (예: OpenAI) */
  label: string;
  /** 대기에 들어갈 때마다 호출. 사용자에게 왜 멈췄는지 보여주기 위함 */
  onRetry?: (notice: RetryNotice) => void;
  /** 사용자 중단 신호. 재시도 대기와 요청 자체 모두 이 신호로 끊는다 */
  signal?: AbortSignal;
};

/**
 * 응답에서 얼마나 기다려야 하는지 알아낸다.
 *
 * 1. Retry-After 헤더 (초 또는 날짜)
 * 2. 본문의 "try again in 5.486s" 같은 안내
 * 3. 둘 다 없으면 지수 백오프
 */
export function resolveWaitMs(
  headers: Headers,
  body: string,
  attempt: number,
): number {
  const header = headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }

  const hint = waitHintMs(body);
  if (hint !== undefined) return hint;

  // 1초, 2초, 4초... 서버가 아무 말도 안 해줄 때만 쓴다
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

/** "try again in 5.486s" 같은 본문 안내에서 대기 시간(ms)을 읽는다 */
function waitHintMs(text: string): number | undefined {
  const hint = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(text);
  if (!hint) return undefined;
  const value = Number(hint[1]);
  if (!Number.isFinite(value)) return undefined;
  return hint[2].toLowerCase() === 'ms' ? value : value * 1000;
}

/**
 * 한도 오류 메시지의 대기 시간. 한도 오류가 아니면 undefined — 재시도 대상이 아니다.
 *
 * 한도 오류는 HTTP 429로만 오지 않는다. 200으로 스트림을 열어준 뒤 SSE error
 * 이벤트에 실려 오기도 하는데, 그 경로는 fetchWithRetry 바깥이라 잡을 수 없다.
 * 스트림을 읽던 쪽이 이 판정으로 재시도 여부를 정한다.
 */
export function rateLimitWaitMs(message: string): number | undefined {
  if (!/rate limit/i.test(message)) return undefined;
  return waitHintMs(message) ?? 5000;
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE.has(status);
}

/** 대기 중에도 사용자 중단(signal)에는 즉시 반응한다 */
export function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('요청이 중단되었습니다.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('요청이 중단되었습니다.'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 실패하면 기다렸다 다시 보낸다. 성공 응답은 본문 내용을 건드리지 않으므로
 * 호출한 쪽에서 스트림으로 읽을 수 있다. 무응답 감시(requestGuard)만 본문에 얹는다.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { label, onRetry, signal }: FetchWithRetryOptions,
): Promise<Response> {
  let lastBody = '';
  let lastStatus = 0;
  let attempts = 0;
  let totalRateLimitWaitMs = 0;

  for (let attempt = 1; ; attempt += 1) {
    attempts = attempt;
    // 시도마다 새로 감시한다. 앞 시도의 대기 시간이 다음 시도의 상한을 먹지 않게
    const guard = requestGuard(signal);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: guard.signal });
    } catch (error) {
      guard.stop();
      throw error;
    }
    // 성공 응답은 본문을 읽는 동안 watch가 감시를 이어받는다
    if (response.ok) return guard.watch(response);

    lastStatus = response.status;
    // 오류 본문은 한 번만 읽을 수 있다. 대기 시간 힌트와 오류 메시지 양쪽에 쓴다
    lastBody = await response.text();
    guard.stop();

    const rateLimited = response.status === 429;
    const maxAttempts = rateLimited ? MAX_RATE_LIMIT_ATTEMPTS : MAX_ATTEMPTS;
    if (!isRetryableStatus(response.status) || attempt >= maxAttempts) break;

    const waitMs = resolveWaitMs(response.headers, lastBody, attempt);
    if (waitMs > MAX_WAIT_MS) break;
    if (rateLimited) {
      totalRateLimitWaitMs += waitMs;
      if (totalRateLimitWaitMs > MAX_TOTAL_RATE_LIMIT_WAIT_MS) break;
    }

    onRetry?.({ attempt, maxAttempts, status: response.status, waitMs });
    await waitFor(waitMs, signal);
  }

  const retried = isRetryableStatus(lastStatus) && attempts > 1
    ? ` (${attempts}회 시도)`
    : '';
  throw new ProviderRequestError({
    body: lastBody,
    message: `${label} 요청 실패 (${lastStatus})${retried}: ${
      lastBody.length > MAX_MESSAGE_BODY_CHARS
        ? `${lastBody.slice(0, MAX_MESSAGE_BODY_CHARS)}…`
        : lastBody
    }`,
    provider: label,
    status: lastStatus,
  });
}
