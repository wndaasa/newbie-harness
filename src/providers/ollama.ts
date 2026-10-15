import { SYSTEM_PROMPT } from '../config.ts';
import { toOllamaMessages } from './images.ts';
import { readOllamaStream } from './streams.ts';
import { fetchWithRetry } from './fetchWithRetry.ts';
import { ollamaSampling } from './sampling.ts';
import { resolveContextWindow } from './contextWindow.ts';
import { effortForProvider } from './openaiResponses.ts';
import type { StreamResult } from './streams.ts';
import {
  type ProviderContext,
  type ProviderRequest,
} from './types.ts';

const OLLAMA_CHAT_PATH = '/api/chat';

/**
 * Ollama의 think 값. 보내지 않으면 모델 기본값으로 생각한다. 제목 생성 같은 짧은
 * 보조 호출은 생각을 끈다. 생각이 num_predict를 먹으면 본문이 비거나 잘린다
 */
export function ollamaThink(
  noReasoning: boolean | undefined,
  reasoningEffort: string | undefined,
): boolean | string {
  if (noReasoning) return false;
  const effort = effortForProvider('ollama', reasoningEffort);
  return effort === 'none' ? false : effort;
}

export async function runOllamaTurn(
  {
    maxTokens,
    model,
    messages,
    noReasoning,
    reasoningEffort,
    systemPrompt = SYSTEM_PROMPT,
    tools,
  }: ProviderRequest,
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
      think: ollamaThink(noReasoning, reasoningEffort),
      // 출력 상한은 options.num_predict로 준다. 빠지면 서버 기본값(무제한)이라 루프가
      // 남은 창에 맞춰 줄인 상한도, 유틸리티 호출의 짧은 상한도 먹히지 않는다.
      // 창 크기는 압축 판정과 같은 값을 num_ctx로 준다. 빠지면 Ollama가 서버 기본값으로
      // 모델을 올려, 앱이 아는 창보다 먼저 넘친다
      options: {
        ...ollamaSampling().options,
        num_predict: maxTokens,
        num_ctx: resolveContextWindow('ollama', model),
      },
      ...(tools?.length ? { tools } : {}),
    }),
  }, { label: 'Ollama', onRetry, signal });

  return readOllamaStream(response.body, output);
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}
