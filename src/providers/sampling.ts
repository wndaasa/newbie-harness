// 설정창의 샘플링 값 (temperature 등).
//
// 값은 자격 증명 저장소(app/main/credentials.ts)가 환경 변수로 얹어 주고, 제공자는
// 요청할 때마다 여기서 읽는다. 비어 있으면 그 항목을 아예 보내지 않아 제공자와
// 모델의 기본값을 따른다 — Qwen처럼 generation_config에 권장값이 든 모델은 안 건드리는
// 것이 맞고, 잘못 보낸 0이 기본값을 덮어쓰는 일도 없다.
//
// 같은 값을 모든 제공자가 공유한다. 제공자마다 받는 항목과 이름이 달라 아래
// 함수들이 각자 필요한 것만 골라 그 API의 이름으로 옮긴다.

export const SAMPLING_KEYS = [
  'NEWBIE_TEMPERATURE',
  'NEWBIE_TOP_P',
  'NEWBIE_TOP_K',
  'NEWBIE_MIN_P',
  'NEWBIE_PRESENCE_PENALTY',
  'NEWBIE_REPETITION_PENALTY',
] as const;

export type SamplingKey = (typeof SAMPLING_KEYS)[number];

export type Sampling = {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
};

const FIELD_OF: Record<SamplingKey, keyof Sampling> = {
  NEWBIE_TEMPERATURE: 'temperature',
  NEWBIE_TOP_P: 'top_p',
  NEWBIE_TOP_K: 'top_k',
  NEWBIE_MIN_P: 'min_p',
  NEWBIE_PRESENCE_PENALTY: 'presence_penalty',
  NEWBIE_REPETITION_PENALTY: 'repetition_penalty',
};

/** 환경에서 숫자로 읽히는 항목만 모은다. 빈 값·숫자 아님은 "안 정한 것" */
export function readSampling(env: NodeJS.ProcessEnv = process.env): Sampling {
  const result: Sampling = {};
  for (const key of SAMPLING_KEYS) {
    const raw = (env[key] ?? '').trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    // top_k는 정수 개수다. 소수를 보내면 vLLM이 400으로 거절한다
    result[FIELD_OF[key]] = key === 'NEWBIE_TOP_K' ? Math.trunc(value) : value;
  }
  return result;
}

function pick<K extends keyof Sampling>(sampling: Sampling, keys: K[]): Pick<Sampling, K> {
  const out = {} as Pick<Sampling, K>;
  for (const key of keys) {
    if (sampling[key] !== undefined) out[key] = sampling[key];
  }
  return out;
}

/** vLLM: OpenAI 필드에 더해 top_k·min_p·repetition_penalty를 같은 이름으로 받는다 */
export function vllmSampling(env?: NodeJS.ProcessEnv): Record<string, number> {
  return { ...readSampling(env) };
}

/** llama.cpp 서버와 LM Studio: 반복 페널티 이름이 repeat_penalty다 */
export function llamaSampling(env?: NodeJS.ProcessEnv): Record<string, number> {
  const { repetition_penalty, ...rest } = readSampling(env);
  return { ...rest, ...(repetition_penalty !== undefined ? { repeat_penalty: repetition_penalty } : {}) };
}

/** Ollama: 본문의 options 객체 안에 넣고, 반복 페널티는 repeat_penalty다 */
export function ollamaSampling(env?: NodeJS.ProcessEnv): { options?: Record<string, number> } {
  const options = llamaSampling(env);
  return Object.keys(options).length ? { options } : {};
}

/** OpenAI chat/completions: temperature와 top_p만 있다 */
export function openAISampling(env?: NodeJS.ProcessEnv): Record<string, number> {
  return pick(readSampling(env), ['temperature', 'top_p']);
}

/**
 * Anthropic: temperature·top_p·top_k를 받지만 최근 모델은 temperature와 top_p를 함께
 * 주면 400이다. 둘 다 있으면 temperature만 보낸다
 */
export function anthropicSampling(env?: NodeJS.ProcessEnv): Record<string, number> {
  const { temperature, top_p, top_k } = readSampling(env);
  return {
    ...(temperature !== undefined ? { temperature } : top_p !== undefined ? { top_p } : {}),
    ...(top_k !== undefined ? { top_k } : {}),
  };
}
