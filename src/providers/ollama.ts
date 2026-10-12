import { SYSTEM_PROMPT } from '../config.ts';
import { toOllamaMessages } from './images.ts';
import { readOllamaStream } from './streams.ts';
import { fetchWithRetry } from './fetchWithRetry.ts';
import { ollamaSampling } from './sampling.ts';
import type { StreamResult } from './streams.ts';
import {
  type ProviderContext,
  type ProviderRequest,
} from './types.ts';

const OLLAMA_CHAT_PATH = '/api/chat';

export async function runOllamaTurn(
  { maxTokens, model, messages, systemPrompt = SYSTEM_PROMPT, tools }: ProviderRequest,
  { onRetry, output, signal }: ProviderContext,
): Promise<StreamResult> {
  const host = trimTrailingSlash(
    process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  );
  const response = await fetchWithRetry(`${host}${OLLAMA_CHAT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...toOllamaMessages(messages)],
      // 출력 상한은 options.num_predict로 준다. 빠지면 서버 기본값(무제한)이라 루프가
      // 남은 창에 맞춰 줄인 상한도, 유틸리티 호출의 짧은 상한도 먹히지 않는다
      options: { ...ollamaSampling().options, num_predict: maxTokens },
      ...(tools?.length ? { tools } : {}),
    }),
  }, { label: 'Ollama', onRetry, signal });

  return readOllamaStream(response.body, output);
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}
