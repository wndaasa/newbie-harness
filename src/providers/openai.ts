import { SYSTEM_PROMPT } from '../config.ts';
import { toOpenAIMessages } from './images.ts';
import { readOpenAIResponsesStream, readOpenAIStream } from './streams.ts';
import { fetchWithRetry, rateLimitWaitMs, waitFor } from './fetchWithRetry.ts';
import { openAISampling } from './sampling.ts';
import { errorMessage } from '../utils/errors.ts';
import {
  resolveReasoningEffort,
  toResponsesInput,
  toResponsesTools,
} from './openaiResponses.ts';
import type { StreamResult } from './streams.ts';
import {
  requireApiKey,
  type ProviderContext,
  type ProviderOutput,
  type ProviderRequest,
} from './types.ts';

/**
 * 스트림 도중 도착한 한도 오류의 재시도.
 *
 * OpenAI의 한도 오류는 HTTP 429로만 오지 않는다. 200으로 스트림을 열어준 뒤
 * SSE error 이벤트로 오기도 하는데, 그 경로는 fetchWithRetry 바깥이라 재시도
 * 없이 턴이 통째로 죽었다 — "try again in 5.102s"를 받아 놓고도 실패한 실사고.
 * 아직 화면에 아무것도 내보내지 않았을 때만 같은 요청을 다시 보낸다 — 출력이
 * 나간 뒤 다시 보내면 같은 답이 두 번 그려진다.
 */
const MAX_STREAM_RATE_LIMIT_ATTEMPTS = 5;

async function readWithRateLimitRetry(
  request: () => Promise<Response>,
  read: (
    body: ReadableStream<Uint8Array> | null,
    output: ProviderOutput,
  ) => Promise<StreamResult>,
  { onRetry, output, signal }: ProviderContext,
): Promise<StreamResult> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await request();
    let emitted = false;
    const guarded: ProviderOutput = {
      write(chunk) {
        emitted = true;
        output.write(chunk);
      },
      writeReasoning(chunk) {
        emitted = true;
        output.writeReasoning?.(chunk);
      },
    };
    try {
      return await read(response.body, guarded);
    } catch (error) {
      const waitMs = rateLimitWaitMs(errorMessage(error));
      if (waitMs === undefined || emitted || attempt >= MAX_STREAM_RATE_LIMIT_ATTEMPTS) {
        throw error;
      }
      onRetry?.({ attempt, maxAttempts: MAX_STREAM_RATE_LIMIT_ATTEMPTS, status: 429, waitMs });
      await waitFor(waitMs, signal);
    }
  }
}

const OPENAI_CHAT_COMPLETIONS_PATH = '/chat/completions';
const OPENAI_RESPONSES_PATH = '/responses';

export async function runOpenAITurn(
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
  const baseUrl = trimTrailingSlash(
    process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  );
  const headers = {
    authorization: `Bearer ${requireApiKey('OPENAI_API_KEY')}`,
    'content-type': 'application/json',
  };
  // noReasoning(짧은 유틸리티 호출)은 추론을 명시적으로 끈다 — 숨은 추론 토큰이
  // 작은 완성 토큰 한도를 먹어 출력이 비거나 잘린다
  const effort = noReasoning
    ? 'none'
    : (reasoningEffort ?? resolveReasoningEffort(process.env.OPENAI_REASONING_EFFORT));

  // 추론 모델의 대화 턴은 Responses API로 보낸다. chat/completions는 도구와 추론을
  // 함께 받지 않아 예전에는 코딩 탭이 항상 추론을 끈 모델로 돌았고, 추론 요약도
  // Responses에서만 온다 (openaiResponses.ts 머리 주석 참고). 제목 생성·분류기
  // 같은 noReasoning 호출은 요약이 필요 없으므로 가벼운 chat/completions에 둔다
  if (isReasoningModel(model) && !noReasoning) {
    return readWithRateLimitRetry(
      () => fetchWithRetry(`${baseUrl}${OPENAI_RESPONSES_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_output_tokens: maxTokens,
          stream: true,
          // 이력은 세션이 갖고 있고 previous_response_id를 쓰지 않으므로 서버에 남기지 않는다
          store: false,
          instructions: systemPrompt,
          input: toResponsesInput(toOpenAIMessages(messages)),
          ...(tools?.length ? { tools: toResponsesTools(tools) } : {}),
          // summary: 요약을 스트림에 실어 달라는 것. 원시 사고 과정은 어차피 안 준다
          reasoning: { effort, summary: 'auto' },
        }),
      }, { label: 'OpenAI', onRetry, signal }),
      readOpenAIResponsesStream,
      { onRetry, output, signal },
    );
  }

  return readWithRateLimitRetry(
    () => fetchWithRetry(`${baseUrl}${OPENAI_CHAT_COMPLETIONS_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        stream: true,
        // 마지막 청크에 실측 usage를 포함시킴 (컨텍스트 게이지용)
        stream_options: { include_usage: true },
        messages: [{ role: 'developer', content: systemPrompt }, ...toOpenAIMessages(messages)],
        // 비추론 모델(gpt-4o 등)은 reasoning_effort 자체를 모르는 인자로 보고 400을
        // 내므로 추론 모델일 때만 붙인다. 도구 없는 호출(채팅 탭)도 같은 강도를 따른다
        ...(isReasoningModel(model) ? { reasoning_effort: effort } : {}),
        // 추론 모델은 temperature·top_p를 거절한다. Responses 경로(위)도 같은 이유로 안 보낸다
        ...(isReasoningModel(model) ? {} : openAISampling()),
        ...(tools?.length ? { tools } : {}),
      }),
    }, { label: 'OpenAI', onRetry, signal }),
    readOpenAIStream,
    { onRetry, output, signal },
  );
}

/** reasoning_effort를 받는 모델인지. prefix 매칭이라 gpt-5.5 같은 세부 버전도 걸린다 */
export function isReasoningModel(model: string) {
  return model.startsWith('gpt-5') || model.startsWith('o1') || model.startsWith('o3');
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}
