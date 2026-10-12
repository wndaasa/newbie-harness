import { SYSTEM_PROMPT } from '../config.ts';
import { toOpenAIMessages } from './images.ts';
import { readOpenAIStream } from './streams.ts';
import { fetchWithRetry } from './fetchWithRetry.ts';
import { llamaSampling } from './sampling.ts';
import type { StreamResult } from './streams.ts';
import {
  type ProviderContext,
  type ProviderRequest,
} from './types.ts';

const LM_STUDIO_CHAT_PATH = '/v1/chat/completions';

export async function runLmStudioTurn(
  { model, maxTokens, messages, systemPrompt = SYSTEM_PROMPT, tools }: ProviderRequest,
  { onRetry, output, signal }: ProviderContext,
): Promise<StreamResult> {
  const baseUrl = trimTrailingSlash(
    process.env.LM_STUDIO_BASE_URL ?? 'http://localhost:1234',
  );
  const response = await fetchWithRetry(`${baseUrl}${LM_STUDIO_CHAT_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.LM_STUDIO_API_KEY ?? 'lm-studio'}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      // 마지막 청크에 실측 usage를 포함시킴 (컨텍스트 게이지용)
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: systemPrompt }, ...toOpenAIMessages(messages)],
      ...llamaSampling(),
      ...(tools?.length ? { tools } : {}),
    }),
  }, { label: 'LM Studio', onRetry, signal });

  return readOpenAIStream(response.body, output);
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}
