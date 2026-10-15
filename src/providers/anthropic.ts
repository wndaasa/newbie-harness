import { SYSTEM_PROMPT } from '../config.ts';
import { toAnthropicMessages } from './images.ts';
import { readAnthropicStream } from './streams.ts';
import { fetchWithRetry } from './fetchWithRetry.ts';
import { anthropicSampling } from './sampling.ts';
import { effortForProvider } from './openaiResponses.ts';
import type { StreamResult } from './streams.ts';
import {
  ENV_CONTEXT_MARKER,
  requireApiKey,
  type ProviderContext,
  type ProviderRequest,
} from './types.ts';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

const EPHEMERAL = { type: 'ephemeral' } as const;

/**
 * Anthropic은 OpenAI와 달리 캐시를 자동으로 걸어주지 않는다. `cache_control`을
 * 붙인 지점까지를 캐시 구간으로 잡으므로, 구간이 끝나는 자리를 직접 표시해야 한다.
 *
 * 요청에서 tools가 system보다 앞에 오므로 system 끝에 표시를 달면 도구 정의까지
 * 한 구간으로 묶인다. 도구 배열 끝에도 달아 두면 대화가 길어져 system 뒤쪽이
 * 바뀌더라도 도구 정의는 캐시에 남는다.
 */
function withToolCache(tools: unknown[]): unknown[] {
  const last = tools[tools.length - 1];
  if (!last || typeof last !== 'object') return tools;
  return [
    ...tools.slice(0, -1),
    { ...(last as Record<string, unknown>), cache_control: EPHEMERAL },
  ];
}

function cacheableSystem(systemPrompt: string) {
  return [{ cache_control: EPHEMERAL, text: systemPrompt, type: 'text' }];
}

type AnthropicMessage = { content?: unknown; [key: string]: unknown };

/**
 * 대화 이력 끝에도 캐시 표시를 단다.
 *
 * system·tools만 캐시하면 정작 가장 큰 이력이 라운드마다 캐시 밖으로 나간다.
 * Anthropic은 캐시에서 읽은 토큰을 분당 입력 한도(ITPM)에 세지 않으므로, 이력이
 * 캐시에 잡히는 만큼 비용만이 아니라 한도 걸림 자체가 줄어든다. 표시는 마지막
 * 메시지의 마지막 content 블록에 단다 — 다음 라운드는 여기까지를 그대로 재사용한다.
 * (한 요청에 캐시 표시는 4개까지: system·tools·이력으로 3개를 쓴다)
 *
 * 맨 끝이 루프가 매 요청 새로 붙이는 환경 정보 메시지면 그 바로 앞 메시지에 단다.
 * 환경 정보에 달면 다음 라운드에는 그 자리에 다른 메시지가 와서 접두사가 어긋나므로
 * 이력 캐시가 한 번도 읽히지 않는다
 */
export function withHistoryCache(messages: AnthropicMessage[]): AnthropicMessage[] {
  const end = isEnvContext(messages.at(-1)) ? messages.length - 1 : messages.length;
  const last = messages[end - 1];
  if (!last) return messages;

  // 문자열 content는 블록 배열로 바꿔야 표시를 달 수 있다. 빈 문자열은 빈 텍스트
  // 블록이 되어 API가 거부하므로 그대로 둔다
  const content =
    typeof last.content === 'string' && last.content
      ? [{ type: 'text', text: last.content }]
      : last.content;
  if (!Array.isArray(content) || content.length === 0) return messages;

  const lastBlock = content.at(-1);
  if (!lastBlock || typeof lastBlock !== 'object') return messages;

  return [
    ...messages.slice(0, end - 1),
    {
      ...last,
      content: [...content.slice(0, -1), { ...lastBlock, cache_control: EPHEMERAL }],
    },
    ...messages.slice(end),
  ];
}

function isEnvContext(message: AnthropicMessage | undefined): boolean {
  return (
    message?.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(ENV_CONTEXT_MARKER)
  );
}

/**
 * output_config.effort를 받는 모델인가. Opus 4.5 이후, Sonnet 4.6 이후, Haiku 5 이후,
 * Fable·Mythos만 받고 Haiku 4.5·Sonnet 4.5 이전 모델은 이 필드에 400을 낸다
 */
export function supportsAnthropicEffort(model: string): boolean {
  return /^claude-(opus-4-[5-9]|sonnet-4-[6-9]|(opus|sonnet|haiku)-([5-9]|\d{2,})|fable-|mythos-)/.test(
    model,
  );
}

/**
 * 추론 강도. 보내지 않으면 모델 기본값으로 돈다(Haiku 5.5는 medium, Sonnet 5는 high).
 * 제목 생성 같은 짧은 보조 호출은 가장 낮게 둔다. 생각에 쓴 토큰도 작은 max_tokens에서
 * 빠져 본문이 비거나 잘린다
 */
export function anthropicEffort(
  model: string,
  noReasoning: boolean | undefined,
  reasoningEffort: string | undefined,
): Record<string, unknown> {
  if (!supportsAnthropicEffort(model)) return {};
  const effort = noReasoning ? 'low' : effortForProvider('anthropic', reasoningEffort);
  return { output_config: { effort } };
}

export async function runAnthropicTurn(
  {
    model,
    maxTokens,
    messages,
    noReasoning,
    reasoningEffort,
    systemPrompt = SYSTEM_PROMPT,
    tools,
  }: ProviderRequest,
  { onRetry, output, signal }: ProviderContext,
): Promise<StreamResult> {
  const response = await fetchWithRetry(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': requireApiKey('ANTHROPIC_API_KEY'),
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      system: cacheableSystem(systemPrompt),
      messages: withHistoryCache(toAnthropicMessages(messages)),
      ...anthropicSampling(),
      ...anthropicEffort(model, noReasoning, reasoningEffort),
      ...(tools?.length ? { tools: withToolCache(tools) } : {}),
    }),
  }, { label: 'Anthropic', onRetry, signal });

  return readAnthropicStream(response.body, output);
}
