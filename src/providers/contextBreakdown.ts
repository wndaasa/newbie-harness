/*
 * 컨텍스트 창을 무엇이 차지하고 있는지 구성별로 잰다.
 *
 * 프로바이더는 입력 토큰 "총합"만 알려준다. 그래서 시스템 프롬프트가 큰 건지
 * 도구 정의가 큰 건지 대화가 쌓인 건지 알 수 없는데, 정작 줄일 수 있는 건
 * 그 셋 중 하나다.
 *
 * 글자 수로 어림하는 방법은 쓰지 않는다. 한국어·영어·JSON이 섞이면 배 이상
 * 틀리는데, 화면에 숫자로 박히면 실측처럼 읽혀서 없느니만 못하다. 대신
 * 제공자의 토큰 계산 엔드포인트로 조합을 바꿔 가며 재고 차분으로 쪼갠다.
 *
 *   Anthropic  /v1/messages/count_tokens — 과금이 없고 레이트리밋도 따로 쓴다
 *   vLLM       /tokenize — messages와 tools를 받아 채팅 템플릿까지 적용해 센다
 *   llama.cpp  /apply-template로 템플릿을 적용한 프롬프트를 받고 /tokenize로 센다.
 *              apply-template은 chat completions와 같은 파서를 쓰므로 tools도 들어간다
 *
 * 세 경우 모두 서버가 실제 요청에서 셀 값과 같은 방식이라 실측이다.
 *
 * 대화 몫은 재지 않는다. 화면이 실측 입력 총합에서 아래 세 조각을 빼면 나오고,
 * 그렇게 하면 측정이 대화 내용과 무관해진다 — 요청이 가벼워지고, 같은 설정을
 * 쓰는 동안 캐시가 계속 맞는다.
 *
 * 잴 수 없는 제공자(OpenAI·Ollama·LM Studio)는 총합만 보여준다. OpenAI는
 * 토크나이저를 공개해 로컬 계산이 가능하지만 라이브러리를 번들에 넣어야 하고,
 * 도구 정의는 내부 형식으로 변환돼 세어지므로 그 부분이 다시 근사가 된다.
 * Ollama와 LM Studio는 토큰을 세 주는 엔드포인트가 없다.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getNewbieHome } from '../memory/globalNewbie.ts';
import { llamaCppBaseUrl } from './llamacpp.ts';
import { requireApiKey } from './types.ts';
import { vllmBaseUrl } from './vllm.ts';

const COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
/** 응답이 없으면 화면이 "측정 중"에 갇힌다. 실패로 끝내는 편이 낫다 */
const COUNT_TIMEOUT_MS = 15_000;
const ANTHROPIC_API_VERSION = '2023-06-01';
/** 대화 없이 고정 구성만 재기 위한 최소 메시지 */
const TINY_MESSAGE = [{ role: 'user', content: '.' }];

const CACHE_FILE = 'context-tokens.json';
/** 모델·프롬프트·도구 조합이 바뀌면 항목이 하나 는다. 오래된 것부터 버린다 */
const MAX_CACHE_ENTRIES = 30;

export type ContextBreakdown = {
  /** 시스템 프롬프트 */
  system: number;
  /** 내장 도구 정의 */
  tools: number;
  /** MCP 서버가 붙인 도구 정의 */
  mcpTools: number;
};

export type TurnInputs = {
  model: string;
  provider: string;
  systemPrompt: string;
  tools: unknown[];
};

/** 구성별 측정이 가능한 제공자인지 */
export function supportsBreakdown(provider: string): boolean {
  return provider === 'anthropic' || provider === 'vllm' || provider === 'llamacpp';
}

/** 한 조합을 재는 요청. 대화는 최소 메시지 하나, 나머지는 있을 때만 싣는다 */
type CountRequest = { system?: string; tools?: unknown[] };

/**
 * 고정 구성(시스템 프롬프트·도구·MCP 도구)을 네 번 재고 차분으로 쪼갠다.
 *
 * 네 번 모두 대화 대신 최소 메시지를 싣는다. 도구 정의는 대화와 무관하게
 * 고정이므로 그 위에서 재는 편이 단순하고, 결과가 대화에 좌우되지 않아
 * 같은 설정을 쓰는 내내 캐시가 유효하다.
 */
export async function measureBreakdown(
  inputs: TurnInputs,
  signal?: AbortSignal,
): Promise<ContextBreakdown> {
  const cached = readCache(cacheKey(inputs));
  if (cached) return cached;

  const { model, provider, systemPrompt, tools } = inputs;
  const builtinTools = tools.filter(tool => !isMcpTool(tool));
  const count = (request: CountRequest) => countTokens(provider, model, request, signal);

  const [withAll, withBuiltin, systemOnly, base] = await Promise.all([
    count({ system: systemPrompt, tools }),
    count({ system: systemPrompt, tools: builtinTools }),
    count({ system: systemPrompt }),
    count({}),
  ]);

  const mcpTools = Math.max(0, withAll - withBuiltin);
  const allTools = Math.max(0, withAll - systemOnly);
  const parts: ContextBreakdown = {
    mcpTools,
    system: Math.max(0, systemOnly - base),
    tools: Math.max(0, allTools - mcpTools),
  };

  writeCache(cacheKey(inputs), parts);
  return parts;
}

/**
 * 캐시 열쇠.
 *
 * 잰 값이 오직 이 넷에만 달려 있으므로 그대로 해시한다. 시스템 프롬프트나 도구
 * 목록이 바뀌면 열쇠도 바뀌는데, 그건 값도 실제로 바뀌었다는 뜻이라 다시 재는 게 맞다.
 */
function cacheKey({ model, provider, systemPrompt, tools }: TurnInputs): string {
  // 제공자를 넣는 이유: 같은 모델 이름이라도 서버마다 토크나이저·채팅 템플릿이 다르다
  return createHash('sha256')
    .update(provider)
    .update('\0')
    .update(model)
    .update('\0')
    .update(systemPrompt)
    .update('\0')
    .update(JSON.stringify(tools))
    .digest('hex')
    .slice(0, 32);
}

function cachePath(): string {
  return join(getNewbieHome(), CACHE_FILE);
}

type CacheFile = Record<string, ContextBreakdown>;

function readCache(key: string): ContextBreakdown | null {
  try {
    const path = cachePath();
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
    const found = parsed[key];
    // 손으로 고쳤거나 형식이 바뀐 파일은 없는 셈 친다 — 다시 재면 그만이다
    if (!found || typeof found.system !== 'number') return null;
    return found;
  } catch {
    return null;
  }
}

function writeCache(key: string, parts: ContextBreakdown): void {
  try {
    const path = cachePath();
    let parsed: CacheFile = {};
    if (existsSync(path)) {
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
      } catch {
        parsed = {};
      }
    }
    parsed[key] = parts;

    // 삽입 순서가 곧 오래된 순서다 (JSON.parse가 순서를 지킨다)
    const keys = Object.keys(parsed);
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_CACHE_ENTRIES))) {
      delete parsed[stale];
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(parsed), 'utf8');
  } catch {
    // 캐시를 못 써도 측정 자체는 됐다. 다음에 다시 재면 된다
  }
}

/** MCP 도구는 이름이 mcp__로 시작한다 (registry가 붙이는 규약) */
function isMcpTool(tool: unknown): boolean {
  const named = tool as { name?: unknown; function?: { name?: unknown } };
  const name = String(named?.name ?? named?.function?.name ?? '');
  return name.startsWith('mcp__');
}

/** 제공자별 토큰 계산으로 나눈다. 미지원 제공자는 supportsBreakdown이 먼저 거른다 */
function countTokens(
  provider: string,
  model: string,
  request: CountRequest,
  signal?: AbortSignal,
): Promise<number> {
  // 호출자의 신호를 받아도 시간 상한은 유지한다. 신호만 따르면 서버가 멈췄을 때 끝나지 않는다
  const timeout = AbortSignal.timeout(COUNT_TIMEOUT_MS);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (provider === 'vllm') return countVllm(model, request, abort);
  if (provider === 'llamacpp') return countLlamaCpp(request, abort);
  return countAnthropic(model, request, abort);
}

async function countAnthropic(
  model: string,
  { system, tools }: CountRequest,
  signal: AbortSignal,
): Promise<number> {
  const json = await postJson<{ input_tokens?: number }>(
    COUNT_TOKENS_URL,
    {
      'x-api-key': requireApiKey('ANTHROPIC_API_KEY'),
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    {
      model,
      messages: TINY_MESSAGE,
      ...(system ? { system } : {}),
      ...(tools ? { tools } : {}),
    },
    signal,
  );
  return Number(json.input_tokens ?? 0);
}

/**
 * vLLM의 /tokenize는 /v1 밖에 있고, messages·tools에 채팅 템플릿을 적용한 뒤
 * 센다. add_generation_prompt까지 켜면 실제 chat completions가 세는 값과 같다.
 * (vllm.ts의 countVllmTokens는 대화 몫을 세는 쪽이고, 여기는 고정 구성만 잰다)
 */
async function countVllm(
  model: string,
  { system, tools }: CountRequest,
  signal: AbortSignal,
): Promise<number> {
  const key = process.env.VLLM_API_KEY;
  const json = await postJson<{ count?: number }>(
    `${vllmBaseUrl().replace(/\/v1$/, '')}/tokenize`,
    key ? { authorization: `Bearer ${key}` } : {},
    {
      model,
      messages: openAiMessages(system),
      add_generation_prompt: true,
      ...(tools?.length ? { tools } : {}),
    },
    signal,
  );
  return Number(json.count ?? 0);
}

/**
 * llama-server는 두 번 왕복한다. /apply-template이 messages·tools에 모델의 채팅
 * 템플릿을 적용한 프롬프트 문자열을 주고, /tokenize가 그 문자열을 센다.
 * add_special·parse_special은 chat completions 경로가 프롬프트를 토큰화할 때
 * 쓰는 값과 맞춘다.
 */
async function countLlamaCpp({ system, tools }: CountRequest, signal: AbortSignal): Promise<number> {
  const base = llamaCppBaseUrl();
  const headers = { authorization: `Bearer ${process.env.LLAMACPP_API_KEY ?? 'llamacpp'}` };
  const templated = await postJson<{ prompt?: string }>(
    `${base}/apply-template`,
    headers,
    { messages: openAiMessages(system), ...(tools?.length ? { tools } : {}) },
    signal,
  );
  const tokenized = await postJson<{ tokens?: unknown[] }>(
    `${base}/tokenize`,
    headers,
    { content: templated.prompt ?? '', add_special: true, parse_special: true },
    signal,
  );
  return Array.isArray(tokenized.tokens) ? tokenized.tokens.length : 0;
}

/** OpenAI 호환 서버용 메시지. 시스템 프롬프트는 system 역할 메시지로 앞에 선다 */
function openAiMessages(system?: string) {
  return system ? [{ role: 'system', content: system }, ...TINY_MESSAGE] : TINY_MESSAGE;
}

async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`토큰 계산 실패 (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as T;
}
