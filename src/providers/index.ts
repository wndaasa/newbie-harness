import { runAnthropicTurn } from './anthropic.ts';
import { runLlamaCppTurn } from './llamacpp.ts';
import { runLmStudioTurn } from './lmstudio.ts';
import { countVllmTokens, runVllmTurn } from './vllm.ts';
import { runMockTurn } from './mock.ts';
import { runOllamaTurn } from './ollama.ts';
import { runOpenAITurn } from './openai.ts';
import type { StreamResult } from './streams.ts';
import { ENV_CONTEXT_MARKER } from './types.ts';
import type { ProviderContext, ProviderTurnSession } from './types.ts';
import type { Session } from '../session/types.ts';
import type { InternalMessage } from './images.ts';

export type { StreamResult } from './streams.ts';

export async function runProviderTurn(
  session: ProviderTurnSession,
  context: ProviderContext & { tools?: unknown[]; systemPrompt?: string },
): Promise<StreamResult> {
  if (session.mock) {
    // 루프가 보내는 사본의 맨 끝에는 환경 정보 메시지가 붙는다. 그걸 사용자 입력으로
    // 읽으면 [도구] 같은 트리거를 영영 못 찾으므로 건너뛴다
    const messages = session.messages.filter(
      message => !String(message.content ?? '').startsWith(ENV_CONTEXT_MARKER),
    );
    const latestUserMessage = String(messages.at(-1)?.content ?? '');
    return runMockTurn(latestUserMessage, messages.length, context);
  }

  const providerSession = {
    ...session,
    systemPrompt: context.systemPrompt ?? session.systemPrompt,
    tools: context.tools ?? [],
  };

  if (session.provider === 'anthropic') {
    return runAnthropicTurn(providerSession, context);
  }

  if (session.provider === 'openai') {
    return runOpenAITurn(providerSession, context);
  }

  if (session.provider === 'ollama') {
    return runOllamaTurn(providerSession, context);
  }

  if (session.provider === 'lmstudio') {
    return runLmStudioTurn(providerSession, context);
  }

  if (session.provider === 'llamacpp') {
    return runLlamaCppTurn(providerSession, context);
  }

  if (session.provider === 'vllm') {
    return runVllmTurn(providerSession, context);
  }

  throw new Error(`지원하지 않는 제공자입니다: ${session.provider}`);
}

/**
 * 이 이력이 실제로 몇 토큰인지 제공자에게 물어본다. 셀 수 없으면 null.
 *
 * 압축 판정이 글자 수 어림에 기대면 크게 빗나간다. 지금은 vLLM만 이 길이 있다
 * (/tokenize). 나머지는 null을 돌려주고 부르는 쪽이 어림값으로 넘어간다.
 */
export async function countProviderTokens(
  session: { model: string; provider: string },
  messages: unknown[],
): Promise<number | null> {
  if (session.provider === 'vllm') return countVllmTokens(session.model, messages);
  return null;
}

export async function runProviderText(
  session: Session,
  options: {
    maxTokens?: number;
    messages: InternalMessage[];
    systemPrompt?: string;
    /**
     * 본 요청과 같은 도구 목록. 넘기면 요청 앞부분(시스템 프롬프트와 도구 정의)이 본
     * 요청과 같아져 제공자가 계산해 둔 앞부분을 다시 쓴다 — 긴 대화를 통째로 다시
     * 읽는 압축 요약에 쓴다. 도구 호출이 와도 실행하지 않고 본문만 돌려준다
     */
    tools?: unknown[];
    /** 추론을 끄지 않고 세션의 추론 강도를 따른다. 앞부분을 본 요청과 맞추려면 같아야 한다 */
    keepReasoning?: boolean;
    /**
     * 턴의 중단 신호. 없으면 사용자가 멈춰도 이 호출은 무응답 감시 시간이 다 될
     * 때까지 붙잡고 있는다
     */
    signal?: AbortSignal;
    /**
     * 응답의 종료 사유를 받는다. 본문을 해석하지 못했을 때 "출력 상한에 걸려 잘렸다"
     * 같은 원인을 함께 남기려는 용도다 (명령 분류기)
     */
    onStopReason?: (stopReason: string | undefined) => void;
  },
): Promise<string> {
  if (session.mock) return '';

  const quietOutput = { write() {} };
  const result = await runProviderTurn(
    {
      ...session,
      maxTokens: options.maxTokens ?? Math.min(session.maxTokens, 220),
      messages: options.messages,
      // 유틸리티 호출(제목·분류기)은 추론을 끈다 — 추론 토큰이 작은
      // maxTokens를 먹으면 출력이 비거나 잘린다 (ProviderRequest.noReasoning 참고)
      ...(options.keepReasoning ? {} : { noReasoning: true }),
      systemPrompt: options.systemPrompt,
    },
    {
      output: quietOutput,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
    },
  );
  options.onStopReason?.(result.stopReason);
  return result.text;
}
