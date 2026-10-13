// vLLM의 OpenAI 호환 서버.
//
// LM Studio·llama.cpp와 같은 계열이지만 따로 두는 이유가 셋 있다.
//
//   인증
//     vLLM은 --api-key로 띄우면 /v1/* 전부에 Authorization: Bearer를 요구한다.
//     LM Studio 제공자는 헤더 없이 목록을 부르고, 그래서 직접 띄운 vLLM에 그 제공자로
//     붙였을 때 401만 돌아왔다. 여기서는 키가 없으면 아예 요청하지 않는다.
//
//   주소
//     기본 포트라 할 만한 것이 없다. 띄울 때 정하는 값이라 Ollama(11434)나
//     LM Studio(1234)처럼 기본값을 넣어 둘 수 없어, 주소를 반드시 받는다.
//
//   컨텍스트 창
//     /v1/models 응답에 max_model_len이 들어 있다. Ollama·LM Studio는 창 크기를
//     따로 물어봐야 하는데 vLLM은 목록에 얹어 준다 (contextWindow.ts 참고).
//
// 서버 기동 옵션에 따라 갈리는 지점이 둘 있다. llama.cpp의 --jinja와 같은 자리다.
//
//   --enable-auto-tool-choice --tool-call-parser hermes
//     없으면 Qwen3가 도구 호출을 <tool_call> 텍스트로 본문에 뱉는다. 500이 아니라
//     조용히 텍스트가 오므로 알아채기 어렵다. 코딩 탭은 매 턴 도구를 보내므로
//     이게 빠지면 도구가 하나도 실행되지 않는다.
//
//   --reasoning-parser qwen3
//     생각을 본문에서 떼어 보낸다. 없으면 <think>...</think>가 그대로 본문에
//     섞여 화면과 세션 이력을 더럽힌다. 다만 필드 이름이 llama.cpp와 다르다 —
//     vLLM 0.28은 delta.reasoning, llama.cpp는 delta.reasoning_content로 보낸다.
//     streams.ts가 두 이름을 모두 받는다.

import { SYSTEM_PROMPT } from '../config.ts';
import { toOpenAIMessages } from './images.ts';
import { readOpenAIStream } from './streams.ts';
import { fetchWithRetry } from './fetchWithRetry.ts';
import type { StreamResult } from './streams.ts';
import {
  type ProviderContext,
  type ProviderRequest,
} from './types.ts';
import { resolveReasoningEffort } from './openaiResponses.ts';
import { vllmSampling } from './sampling.ts';

const VLLM_CHAT_PATH = '/chat/completions';

/**
 * 이 값 이하의 max_tokens는 그대로 보낸다.
 *
 * 제목 생성·분류기처럼 일부러 작게 잡은 호출은 그 상한이 의미가 있다. 반대로
 * 기본값(config.ts의 DEFAULT_MAX_TOKENS = 32768)은 20만 토큰 창을 가진 클라우드
 * 모델 기준이라 vLLM에 그대로 보낼 수 없다 — 아래 주석 참고.
 */
const PASS_THROUGH_MAX_TOKENS = 8_192;

/** 토큰 세기는 매 라운드 앞에 끼므로 오래 붙잡고 있으면 안 된다 */
const TOKENIZE_TIMEOUT_MS = 4_000;

/**
 * 주소를 있는 그대로 쓴다.
 *
 * llama.cpp 쪽은 base에서 /v1을 떼어내지만 여기서는 반대다 — vLLM의 base URL은
 * 관례상 .../v1까지 포함하고(서버 문서와 다른 클라이언트 설정이 모두 그렇다),
 * 경로를 코드가 덧붙이면 붙여 넣은 주소와 실제로 나가는 주소가 달라진다.
 * 설정창의 예시와 안내가 /v1까지 보여 주는 것으로 맞춘다.
 */
export function vllmBaseUrl(): string {
  const value = process.env.VLLM_BASE_URL?.trim();
  if (!value) {
    throw new Error(
      'VLLM_BASE_URL이 필요합니다. 설정 > 제공자에서 vLLM 주소를 입력하세요.',
    );
  }
  return value.replace(/\/+$/, '');
}

/**
 * vLLM에게 직접 토큰 수를 물어본다. 못 물어보면 null.
 *
 * 압축 판정을 글자 수 어림으로 하면 크게 어긋난다 — 같은 모델에서도 한국어
 * 산문은 1.5자에 한 토큰, 코드는 4자에 한 토큰이라 두 배 넘게 벌어진다.
 * 실제로 게이지가 14k를 가리키는 동안 서버는 40,961을 세고 있었다.
 *
 * /tokenize는 /v1 밖에 있다. 서버를 --api-key로 띄웠으면 이 경로도 키를 요구할 수
 * 있어 키가 있으면 함께 보낸다. 채팅 템플릿까지 적용한
 * 값이라 서버가 실제로 셀 값과 같다. 다만 tools는 받지 않으므로 도구 정의
 * 분량은 이 값에 들어가지 않는다 — 부르는 쪽에서 따로 더해야 한다.
 */
export async function countVllmTokens(
  model: string,
  messages: unknown[],
): Promise<number | null> {
  try {
    // base URL은 .../v1까지 포함하는데 이 엔드포인트는 그 밖에 있다
    const root = vllmBaseUrl().replace(/\/v1$/, '');
    const key = process.env.VLLM_API_KEY;
    const response = await fetch(`${root}/tokenize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model, messages, add_generation_prompt: true }),
      signal: AbortSignal.timeout(TOKENIZE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const json = await response.json();
    const count = Number(json?.count);
    return Number.isFinite(count) && count >= 0 ? count : null;
  } catch {
    // 세는 데 실패했다고 대화를 막지 않는다. 부르는 쪽이 어림값으로 넘어간다
    return null;
  }
}

/**
 * 사고 깊이. UI의 none/low/medium/high를 Qwen3.8 템플릿이 받는 low/medium/xhigh로 옮긴다.
 *
 * 안 보내면 템플릿 기본값이 xhigh라 단순한 지시에도 최대 깊이로 생각한다 — 같은
 * 문장을 서너 번 다시 읽고 확정된 설계를 매 턴 처음부터 다시 도출하던 추론이
 * 그것이다. 템플릿은 모르는 값에 예외를 던져 400이 되므로 위 세 값만 보낸다.
 * 'none'은 사고 자체를 끈다 (짧은 유틸리티 호출의 noReasoning과 같은 스위치)
 */
export function vllmReasoning(
  noReasoning: boolean | undefined,
  reasoningEffort: string | undefined,
): Record<string, unknown> {
  const effort = noReasoning ? 'none' : resolveReasoningEffort(reasoningEffort);
  if (effort === 'none') return { chat_template_kwargs: { enable_thinking: false } };
  if (effort === 'high' || effort === 'xhigh') return { reasoning_effort: 'xhigh' };
  if (effort === 'low' || effort === 'minimal') return { reasoning_effort: 'low' };
  return { reasoning_effort: 'medium' };
}

export async function runVllmTurn(
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
  // --api-key 없이 띄운 서버는 헤더 없이 받는다. 키를 건 서버에 키가 빠지면 오는
  // 401은 오류 분류가 키 거부로 알려 준다
  const key = process.env.VLLM_API_KEY;
  const response = await fetchWithRetry(`${vllmBaseUrl()}${VLLM_CHAT_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      // max_tokens는 출력 상한이 아니라 "입력과 합쳐 max_model_len 안에 들어가야
      // 하는 예약분"이다. vLLM은 생성 전에 입력 + max_tokens <= max_model_len을
      // 검사하고 넘으면 400으로 거절한다. 기본값 32768을 그대로 보내면 40960짜리
      // 창에서는 입력이 8,193만 돼도 거절된다 — 실제로 두 턴 만에 그렇게 죽었다.
      // 컨텍스트가 찬 것이 아니라 예약분이 컸던 것이라 게이지는 멀쩡해 보인다.
      //
      // 생략하면 vLLM이 max_model_len - 입력을 알아서 잡는다. 창 자체가 상한이라
      // 폭주해도 그 안에 갇히고, 긴 파일을 쓸 때 인자가 잘리는 문제(그 상한을 둔
      // 원래 이유)에는 오히려 여유가 더 생긴다.
      ...(maxTokens && maxTokens <= PASS_THROUGH_MAX_TOKENS ? { max_tokens: maxTokens } : {}),
      stream: true,
      // 마지막 청크에 실측 usage를 포함시킴 (컨텍스트 게이지용)
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: systemPrompt }, ...toOpenAIMessages(messages)],
      // 제목 생성·분류기처럼 짧은 유틸리티 호출은 생각을 끈다. Qwen3의 생각도
      // 완성 토큰을 쓰므로, 켜 둔 채로 60토큰을 주면 그 60을 생각이 다 먹고
      // 본문이 비어 버린다 — 자동 제목이 안 붙던 원인이 이것이다.
      // llama.cpp도 같은 자리에서 같은 키를 쓴다 (llamacpp.ts)
      ...vllmReasoning(noReasoning, reasoningEffort),
      ...vllmSampling(),
      ...(tools?.length ? { tools } : {}),
    }),
  }, { label: 'vLLM', onRetry, signal });

  return readOpenAIStream(response.body, output);
}
