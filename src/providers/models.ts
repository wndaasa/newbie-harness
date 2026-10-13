import { llamaCppBaseUrl } from './llamacpp.ts';
import { vllmBaseUrl } from './vllm.ts';
import { ProviderRequestError } from './fetchWithRetry.ts';

// 프로바이더별 사용 가능한 모델 목록 조회 (모델 선택 UI용)

const FETCH_TIMEOUT_MS = 5_000;

// 채팅에 못 쓰는 OpenAI 모델(임베딩·음성·이미지 등) 제외용
const OPENAI_EXCLUDE =
  /embedding|tts|whisper|dall-e|audio|image|moderation|davinci|babbage|realtime|transcribe|codex/;

export async function listProviderModels(provider: string): Promise<string[]> {
  if (provider === 'ollama') return listOllamaModels();
  if (provider === 'lmstudio') return listLmStudioModels();
  if (provider === 'llamacpp') return listLlamaCppModels();
  if (provider === 'openai') return listOpenAIModels();
  if (provider === 'vllm') return listVllmModels();
  if (provider === 'anthropic') return listAnthropicModels();
  return [];
}

async function listOllamaModels(): Promise<string[]> {
  const host = trimSlash(process.env.OLLAMA_HOST ?? 'http://localhost:11434');
  const json = await fetchJson(`${host}/api/tags`, {}, 'Ollama');
  return (json.models ?? []).map((m: { name: unknown }) => String(m.name)).sort();
}

async function listLmStudioModels(): Promise<string[]> {
  const host = trimSlash(process.env.LM_STUDIO_BASE_URL ?? 'http://localhost:1234');
  const json = await fetchJson(`${host}/v1/models`, {}, 'LM Studio');
  return (json.data ?? []).map((m: { id: unknown }) => String(m.id)).sort();
}

// llama-server는 물고 있는 모델 하나만 돌려준다. 목록이라기보다 "지금 뭐가
// 떠 있는지" 확인에 가깝고, id는 서버를 띄울 때 준 --alias 값이다
async function listLlamaCppModels(): Promise<string[]> {
  const json = await fetchJson(`${llamaCppBaseUrl()}/v1/models`, {}, 'llama.cpp');
  return (json.data ?? []).map((m: { id: unknown }) => String(m.id)).sort();
}

// vLLM은 서버가 물고 있는 모델만 돌려준다. 목록이라기보다 "지금 뭐가 떠 있는지"에
// 가깝고, id는 --served-model-name 값이다. 걸러낼 잡음이 없어 그대로 쓴다
async function listVllmModels(): Promise<string[]> {
  const key = process.env.VLLM_API_KEY;
  // 키가 있으면 채팅과 같은 헤더를 붙인다. 키를 건 서버에 키가 빠지거나 틀려서 오는
  // 401은 fetchJson이 키 거부로 분류해 알려 준다
  const json = await fetchJson(
    `${vllmBaseUrl()}/models`,
    key ? { authorization: `Bearer ${key}` } : {},
    'vLLM',
  );
  return (json.data ?? []).map((m: { id: unknown }) => String(m.id)).sort();
}

async function listOpenAIModels(): Promise<string[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY가 필요합니다.');
  // 채팅은 OPENAI_BASE_URL을 따르는데(openai.ts) 여기만 주소가 박혀 있었다.
  // 그 값을 넣은 환경에서는 대화는 되고 모델 목록만 실패했다
  const baseUrl = trimSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
  const custom = baseUrl !== 'https://api.openai.com/v1';
  const json = await fetchJson(`${baseUrl}/models`, { authorization: `Bearer ${key}` }, 'OpenAI');
  const ids = (json.data ?? []).map((m: { id: unknown }) => String(m.id));
  // 제외 목록과 역순 정렬은 OpenAI 카탈로그의 잡음(embedding·tts·dall-e)을
  // 걸러내려는 것이다. 호환 서버의 목록은 짧고 의도된 것이라 그대로 두지 않으면
  // 멀쩡한 모델이 이름 때문에 사라진다
  if (custom) return ids.sort();
  return ids
    .filter((id: string) => !OPENAI_EXCLUDE.test(id))
    .sort()
    .reverse(); // 대체로 최신 세대가 이름 역순 정렬에서 앞에 옴
}

async function listAnthropicModels(): Promise<string[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY가 필요합니다.');
  const json = await fetchJson(
    'https://api.anthropic.com/v1/models?limit=50',
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    'Anthropic',
  );
  return (json.data ?? []).map((m: { id: unknown }) => String(m.id));
}

async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
  provider = '',
): Promise<any> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    // 상태 코드만 보여 주면 무엇을 고쳐야 할지 알 수 없다. 대화 오류와 같은
    // 분류를 태워 "키가 거부됐다"까지 말해 준다
    const body = await response.text().catch(() => '');
    throw new ProviderRequestError({
      body,
      message: `모델 목록 요청 실패 (${response.status})`,
      provider,
      status: response.status,
    });
  }
  return response.json();
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, '');
}
