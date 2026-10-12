// llama.cpp(llama-server) 프로바이더.
//
// llama-server는 OpenAI 호환 /v1/chat/completions를 직접 제공하므로 요청 형태는
// openai.ts·lmstudio.ts와 같다. 그런데도 파일을 따로 두는 이유는, 서버를 어떻게
// 띄웠느냐에 따라 동작이 갈리는 지점이 llama.cpp에만 있기 때문이다.
//
//   --jinja
//     없으면 tools를 받는 즉시 "tools param requires --jinja flag" 예외를 던진다
//     (llama.cpp tools/server/server-common.cpp). 이 하네스는 코딩 모드에서 매 턴
//     도구 정의를 보내므로, 빠뜨리면 모든 턴이 500으로 죽는다. 모델의 채팅 템플릿과
//     tool-call 파싱(Qwen3는 hermes-2-pro 계열)도 이 플래그로 켜진다.
//
//   --reasoning-format deepseek
//     생각을 본문에서 떼어 delta.reasoning_content로 보낸다. none(기본 auto)으로
//     두면 <think>...</think>가 그대로 delta.content에 섞여 화면과 세션 이력을
//     더럽힌다. 분리된 생각은 readOpenAIStream이 writeReasoning으로 흘린다.
//
// 서버 실행은 리포 루트의 run_model.sh 참고.

import { SYSTEM_PROMPT } from '../config.ts';
import { toOpenAIMessages } from './images.ts';
import { readOpenAIStream } from './streams.ts';
import { fetchWithRetry } from './fetchWithRetry.ts';
import { llamaSampling } from './sampling.ts';
import type { StreamResult } from './streams.ts';
import { type ProviderContext, type ProviderRequest } from './types.ts';

const LLAMACPP_CHAT_PATH = '/v1/chat/completions';

/** 기본 주소. run_model.sh가 띄우는 포트와 맞춘다 */
export const LLAMACPP_DEFAULT_BASE_URL = 'http://localhost:8080';

/**
 * base URL을 정규화한다.
 *
 * 경로는 이 모듈이 /v1/... 로 붙이므로 base에는 /v1이 없어야 한다. 그런데 다른
 * 도구들이 base_url을 ".../v1"로 요구하는 일이 많아 그대로 적어 넣기 쉽고, 그러면
 * /v1/v1/chat/completions로 나가 404가 난다. 원인을 찾기 어려운 실수라 여기서 흡수한다.
 */
export function llamaCppBaseUrl(): string {
  const raw = process.env.LLAMACPP_BASE_URL ?? LLAMACPP_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export async function runLlamaCppTurn(
  { model, maxTokens, messages, noReasoning, systemPrompt = SYSTEM_PROMPT, tools }: ProviderRequest,
  { onRetry, output, signal }: ProviderContext,
): Promise<StreamResult> {
  const response = await fetchWithRetry(`${llamaCppBaseUrl()}${LLAMACPP_CHAT_PATH}`, {
    method: 'POST',
    headers: {
      // llama-server는 --api-key를 준 경우에만 검사한다. 로컬 기본 구성에서는
      // 무엇을 보내도 통과하므로 더미로 채운다 (헤더 자체를 빼면 일부 역방향
      // 프록시가 막는다)
      authorization: `Bearer ${process.env.LLAMACPP_API_KEY ?? 'llamacpp'}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      // 마지막 청크에 실측 usage를 포함시킴 (컨텍스트 게이지용)
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: systemPrompt }, ...toOpenAIMessages(messages)],
      // 제목·분류기 같은 짧은 보조 호출은 생각을 끈다. 하네스가 이 호출들의
      // 토큰 한도를 220으로 묶는데(runProviderText), 생각이 켜져 있으면 그것만으로
      // 300~400토큰을 써서 본문이 빈 채로 끝난다.
      //
      // 하이브리드 모델(Qwen3-8B 등)은 채팅 템플릿이 enable_thinking을 보고 생각
      // 블록을 통째로 빼므로 한도 안에 답이 들어온다. 추론 전용 모델(예:
      // Qwen3-30B-A3B-Thinking-2507)은 템플릿에 이 변수가 아예 없어 조용히
      // 무시되고 — 붙여도 해는 없지만 — 제목이 계속 비게 된다. 그런 모델을 쓸
      // 거라면 보조 호출만 받을 작은 하이브리드 모델을 따로 띄워야 한다.
      ...(noReasoning ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      ...llamaSampling(),
      ...(tools?.length ? { tools } : {}),
    }),
  }, { label: 'llama.cpp', onRetry, signal });

  return readOpenAIStream(response.body, output);
}
