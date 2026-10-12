// 프로바이더 요청의 중단 신호와 무응답 감시.
//
// 기존에는 본 채팅 요청에만 타임아웃이 없어서(모델 목록·컨텍스트 창 조회에는
// 있었다) 응답이 멈추면 턴이 영원히 끝나지 않고 busy가 풀리지 않았다.
//
// 처음에는 요청 시작부터 5분을 절대 상한으로 걸었는데, 그 신호는 본문 스트림까지
// 함께 끊는다. 큰 컨텍스트에 사고를 켠 모델은 한 턴이 5분을 넘기기도 해서,
// 토큰이 멀쩡히 흘러오는 중에도 "aborted due to timeout"으로 턴이 죽었다.
// 그래서 절대 상한이 아니라 "마지막 청크 이후 이만큼 아무것도 안 오면"으로 끊는다.
// 응답이 시작되기 전(헤더 대기)에도 같은 시간이 적용된다. 실제로 멈춘 경우는
// 사용자가 중단 버튼으로 즉시 끊을 수 있다.
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

function timeoutMs(): number {
  const value = Number(process.env.NEWBIE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REQUEST_TIMEOUT_MS;
}

export type RequestGuard = {
  /** fetch에 넘길 신호. 사용자 중단과 무응답 중 먼저 걸리는 쪽이 요청을 끊는다 */
  signal: AbortSignal;
  /** 본문 청크가 올 때마다 시계를 되돌리는 응답으로 감싼다. 스트림이 끝나면 감시도 끝난다 */
  watch(response: Response): Response;
  /** 응답이 본문 없이 끝났거나 요청 자체가 실패했을 때 감시를 멈춘다 */
  stop(): void;
};

export function requestGuard(userSignal?: AbortSignal): RequestGuard {
  const limit = timeoutMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    stop();
    timer = setTimeout(() => {
      controller.abort(new DOMException(
        `${Math.round(limit / 1000)}초 동안 응답이 없어 요청을 끊었습니다.`,
        'TimeoutError',
      ));
    }, limit);
  };

  if (userSignal?.aborted) {
    controller.abort(userSignal.reason);
  } else {
    userSignal?.addEventListener('abort', () => {
      stop();
      controller.abort(userSignal.reason);
    }, { once: true });
    arm();
  }

  return {
    signal: controller.signal,
    stop,
    watch(response) {
      if (!response.body) {
        stop();
        return response;
      }
      const reader = response.body.getReader();
      // 읽기가 중단 신호와 경쟁하게 한다. fetch 구현이 중단 시 본문을 오류로 끝내
      // 주는지에 기대지 않아야 어떤 런타임에서도 멈춘 읽기가 확실히 풀린다
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(controller.signal.reason);
          reader.cancel(controller.signal.reason).catch(() => {});
        }, { once: true });
      });
      aborted.catch(() => {});
      const body = new ReadableStream<Uint8Array>({
        async pull(ctl) {
          try {
            const { value, done } = await Promise.race([reader.read(), aborted]);
            if (done) {
              stop();
              ctl.close();
              return;
            }
            arm();
            ctl.enqueue(value);
          } catch (error) {
            stop();
            ctl.error(error);
          }
        },
        cancel(reason) {
          stop();
          return reader.cancel(reason);
        },
      });
      return new Response(body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    },
  };
}

/** 중단이 사용자가 누른 것인지 판별해 오류 문구를 구분하기 위함 */
export function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}
