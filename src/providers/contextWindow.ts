import { vllmBaseUrl } from './vllm.ts';
import { llamaCppBaseUrl } from './llamacpp.ts';
import { cachedAnthropicModelInfo, fetchAnthropicModelInfo } from './modelCapabilities.ts';

// 프로바이더별 컨텍스트 창 크기 조회 (토큰 게이지용)
//
// Anthropic(/v1/models/{id})·Ollama(/api/show)·LM Studio(/api/v0/models)·
// llama.cpp(/props)·vLLM(/models)은 API로 실제 값을 조회한다. OpenAI는 창 크기를
// 알려주는 API가 없어 공시 값 테이블을 쓰고, OPENAI_CONTEXT_WINDOW로 덮어쓸 수 있다.

const FETCH_TIMEOUT_MS = 5_000;

// provider:model → API로 조회된 창 크기
const fetchedWindows = new Map<string, number>();

/**
 * Ollama에 보낼 기본 창 크기. Ollama는 요청에 num_ctx가 없으면 서버 기본값으로 모델을
 * 올리는데, 그래픽카드 메모리가 24GiB 미만이면 4K라 에이전트가 쓰기에는 작다.
 * 앱이 정한 창은 ollama.ts가 요청마다 num_ctx로 보내므로 그대로 실제 창이 된다
 */
export const OLLAMA_DEFAULT_NUM_CTX = 32_768;

// Anthropic은 Models API(max_input_tokens)로 모델별 실제 값을 조회한다
// (modelCapabilities.ts). 이 값은 조회 전이거나 실패했을 때만 쓰는 보수적 기본값이다
const ANTHROPIC_FALLBACK_CONTEXT_WINDOW = 200_000;

// OpenAI 모델 패밀리별 공시 컨텍스트 창.
// prefix 매칭이라 구체적인 이름이 먼저 와야 함 (gpt-4.1 → gpt-4o → gpt-4 순)
const OPENAI_CONTEXT_WINDOWS: [string, number][] = [
  ['gpt-5', 400_000],
  ['gpt-4.1', 1_047_576],
  ['gpt-4o', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 8_192],
  ['gpt-3.5-turbo', 16_385],
  ['o1-mini', 128_000],
  ['o1', 200_000],
  ['o3', 200_000],
  ['o4', 200_000],
];

// 동기 조회: API 조회값 캐시 → 모델별 테이블 → Ollama 기본값 → 이름의 "32k" 표기 → 보수적 기본값
export function resolveContextWindow(provider: string, model: string): number {
  const fetched = fetchedWindows.get(`${provider}:${model}`);
  if (fetched) return fetched;

  const name = String(model).toLowerCase();
  if (provider === 'anthropic') {
    return cachedAnthropicModelInfo(model)?.contextWindow ?? ANTHROPIC_FALLBACK_CONTEXT_WINDOW;
  }
  if (provider === 'openai') {
    // 표에 없는 새 모델이나 호환 서버는 사용자가 값을 줄 수 있게 한다
    const override = Number(process.env.OPENAI_CONTEXT_WINDOW);
    if (Number.isFinite(override) && override > 0) return override;
    for (const [prefix, window] of OPENAI_CONTEXT_WINDOWS) {
      if (name.startsWith(prefix)) return window;
    }
    return 128_000;
  }
  // 조회 전이거나 조회에 실패해도 요청에는 이 값이 num_ctx로 나가므로 기본값과 맞춘다
  if (provider === 'ollama') return OLLAMA_DEFAULT_NUM_CTX;

  const match = name.match(/(\d+)k/);
  if (match) return Number(match[1]) * 1000;
  return 8_000;
}

// 로컬 프로바이더의 실제 창 크기를 API로 조회함. 서버가 꺼져 있거나
// 값을 못 찾으면 null을 반환하고 동기 폴백 값이 유지됨.
export async function fetchContextWindow(
  provider: string,
  model: string,
): Promise<number | null> {
  const key = `${provider}:${model}`;
  const cached = fetchedWindows.get(key);
  if (cached) return cached;

  try {
    let window: number | null = null;
    if (provider === 'anthropic') window = (await fetchAnthropicModelInfo(model))?.contextWindow ?? null;
    if (provider === 'ollama') window = await fetchOllamaContextWindow(model);
    if (provider === 'lmstudio') window = await fetchLmStudioContextWindow(model);
    if (provider === 'llamacpp') window = await fetchLlamaCppContextWindow();
    if (provider === 'vllm') window = await fetchVllmContextWindow(model);
    if (window) fetchedWindows.set(key, window);
    return window;
  } catch {
    return null;
  }
}

/**
 * vLLM: GET /models → data[].max_model_len
 *
 * 다른 로컬 제공자와 달리 모델 목록에 창 크기가 함께 실려 온다. 그 값은 서버를
 * 띄울 때 준 --max-model-len이라 모델의 최대치가 아니라 실제 창이다.
 */
async function fetchVllmContextWindow(model: string): Promise<number | null> {
  const key = process.env.VLLM_API_KEY;
  const response = await fetch(`${vllmBaseUrl()}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const json = await response.json();
  const entries: { id?: unknown; max_model_len?: unknown }[] = json.data ?? [];
  // 서버가 모델 하나만 물고 있는 것이 보통이라, 이름이 어긋나도 하나뿐이면 그걸 쓴다
  const found = entries.find(entry => String(entry.id) === model) ?? entries[0];
  const window = Number(found?.max_model_len);
  return Number.isFinite(window) && window > 0 ? window : null;
}

async function fetchOllamaContextWindow(model: string): Promise<number | null> {
  const host = trimSlash(process.env.OLLAMA_HOST ?? 'http://localhost:11434');
  const response = await fetch(`${host}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const json = await response.json();

  // Modelfile에 num_ctx가 있으면 그 값을 쓰고, 없으면 기본값을 모델 최대치 안에서 쓴다
  const numCtx = String(json.parameters ?? '').match(/num_ctx\s+(\d+)/);
  if (numCtx) return Number(numCtx[1]);
  for (const [key, value] of Object.entries(json.model_info ?? {})) {
    if (key.endsWith('.context_length')) return Math.min(Number(value), OLLAMA_DEFAULT_NUM_CTX);
  }
  return OLLAMA_DEFAULT_NUM_CTX;
}

async function fetchLmStudioContextWindow(model: string): Promise<number | null> {
  const host = trimSlash(process.env.LM_STUDIO_BASE_URL ?? 'http://localhost:1234');
  const response = await fetch(`${host}/api/v0/models/${encodeURIComponent(model)}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const json = await response.json();

  // 로드된 값이 실제 창이고, 아직 로드 전이면 모델 최대값
  return json.loaded_context_length ?? json.max_context_length ?? null;
}

/**
 * llama.cpp: GET /props → default_generation_settings.n_ctx
 *
 * 모델 이름을 받지 않는다. llama-server는 한 번에 모델 하나만 물고 있고, 실제
 * 창 크기는 모델이 아니라 서버를 띄울 때 준 --ctx-size가 정하기 때문이다
 * (모델의 최대치보다 작게 띄우는 것이 보통이다 — VRAM 때문에).
 */
async function fetchLlamaCppContextWindow(): Promise<number | null> {
  const response = await fetch(`${llamaCppBaseUrl()}/props`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const json = await response.json();
  return json.default_generation_settings?.n_ctx ?? null;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, '');
}
