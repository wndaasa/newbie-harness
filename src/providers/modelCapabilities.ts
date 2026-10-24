// 제공자 API가 알려 주는 모델 정보 (컨텍스트 창·추론 강도).
//
// 모델 이름으로 창 크기와 받는 강도를 추정하는 표는 새 모델이 나올 때마다 낡는다.
// Anthropic Models API(GET /v1/models/{id})는 모델마다 max_input_tokens와
// capabilities.effort(단계별 supported)를 돌려주므로 그 값을 쓴다. 조회에 실패하거나
// 키가 없으면 null을 돌려주고, 부르는 쪽이 보수적인 기본값으로 돌아간다.

const FETCH_TIMEOUT_MS = 5_000;
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * 앱이 아는 추론 강도 전체를 낮은 것부터 늘어놓은 것. 강도를 가장 가까운 단계로
 * 맞출 때 이 순서를 쓴다 (openaiResponses.ts의 clampEffort)
 */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type AnthropicModelInfo = {
  /** max_input_tokens. 응답에 없거나 0이면 null */
  contextWindow: number | null;
  /** output_config.effort를 받는가. 응답에 정보가 없으면 null (이름 규칙으로 판정) */
  effortSupported: boolean | null;
  /** 받는 강도 단계 (EFFORT_ORDER 순). 정보가 없으면 빈 배열 */
  efforts: string[];
};

const anthropicInfo = new Map<string, AnthropicModelInfo>();

/** 이미 조회한 정보만 동기로 돌려준다. 요청을 조립하는 경로는 기다릴 수 없어서다 */
export function cachedAnthropicModelInfo(model: string): AnthropicModelInfo | undefined {
  return anthropicInfo.get(model);
}

/**
 * 모델 정보를 조회해 캐시한다. 키가 없거나, 요청이 실패하거나, 모델을 모르면 null.
 * 실패는 캐시하지 않는다 — 키를 넣거나 네트워크가 돌아오면 다음 조회에서 받는다
 */
export async function fetchAnthropicModelInfo(model: string): Promise<AnthropicModelInfo | null> {
  const cached = anthropicInfo.get(model);
  if (cached) return cached;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !model) return null;
  try {
    const response = await fetch(`${ANTHROPIC_MODELS_URL}/${encodeURIComponent(model)}`, {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_API_VERSION },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const info = parseAnthropicModelInfo(await response.json());
    anthropicInfo.set(model, info);
    return info;
  } catch {
    return null;
  }
}

/** Models API 응답 → 앱이 쓰는 정보. 모르는 형태여도 던지지 않고 빈 값으로 둔다 */
export function parseAnthropicModelInfo(json: unknown): AnthropicModelInfo {
  const body = (json ?? {}) as {
    max_input_tokens?: unknown;
    capabilities?: { effort?: Record<string, unknown> & { supported?: unknown } };
  };
  const window = Number(body.max_input_tokens);
  const effort = body.capabilities?.effort;
  const efforts =
    effort && typeof effort === 'object'
      ? EFFORT_ORDER.filter(
          level => (effort[level] as { supported?: unknown } | undefined)?.supported === true,
        )
      : [];
  return {
    contextWindow: Number.isFinite(window) && window > 0 ? window : null,
    effortSupported: typeof effort?.supported === 'boolean' ? effort.supported : null,
    efforts: [...efforts],
  };
}
