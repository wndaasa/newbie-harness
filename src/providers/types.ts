// 프로바이더 호출 계약.
//
// messages·tools는 프로바이더마다 형태가 달라(Anthropic content 블록,
// OpenAI tool_calls 등) 여기서는 구조를 고정하지 않는다. 변환은 각 프로바이더
// 모듈과 images.ts·toolHistory.ts가 맡는다.

import type { InternalMessage } from './images.ts';
import type { RetryNotice } from './fetchWithRetry.ts';
import type { Session } from '../session/types.ts';

/** 스트리밍 텍스트가 흘러나가는 곳 (렌더러 행 갱신 또는 stdout) */
export type ProviderOutput = {
  write(chunk: string): void;
  /**
   * 추론 요약 청크. 본문보다 먼저 흘러오며, 지원하는 프로바이더(OpenAI
   * Responses)에서만 온다. 받는 쪽이 없으면 조용히 버려진다
   */
  writeReasoning?(chunk: string): void;
};

/** 프로바이더에 넘길 요청 내용 */
export type ProviderRequest = {
  model: string;
  maxTokens: number;
  messages: InternalMessage[];
  /**
   * 추론(reasoning)을 명시적으로 끈다. 제목 생성·명령 분류기처럼
   * 짧은 유틸리티 호출용 — 추론 모델은 숨은 추론 토큰도 완성 토큰 한도에서
   * 소모하므로, 켜진 채로 두면 작은 maxTokens가 추론에 다 먹혀 출력이 비거나
   * 중간에 잘린다 (제목이 "코드 실행 및 실"로 끊긴 실측 사례).
   */
  noReasoning?: boolean;
  /**
   * 추론 강도. 없으면 OpenAI는 OPENAI_REASONING_EFFORT → 기본값, 나머지는 기본값을 쓴다.
   * 제공자마다 받는 값은 effortForProvider가 맞춘다
   */
  reasoningEffort?: string;
  systemPrompt?: string;
  tools?: unknown[];
};

/**
 * 프로바이더 호출 시점의 세션.
 *
 * messages는 세션에 저장된 중립 포맷이 아니라 expandToolHistory·images를 거쳐
 * API가 받을 형태로 펼쳐진 것이므로 Session과 타입이 다르다.
 */
export type ProviderTurnSession = Omit<Session, 'messages'> & {
  messages: InternalMessage[];
  noReasoning?: boolean;
  tools?: unknown[];
};

export type ProviderContext = {
  output: ProviderOutput;
  /**
   * 한도 초과·일시 장애로 기다렸다 다시 보낼 때 호출됨.
   * 화면이 멈춘 것처럼 보이지 않게 이유를 알리는 용도.
   */
  onRetry?: (notice: RetryNotice) => void;
  /** 사용자 중단·타임아웃 신호 */
  signal?: AbortSignal;
};

/**
 * 에이전트 루프가 보내는 사본 맨 끝에 붙이는 환경 정보 메시지의 머리.
 * 모델이 사용자의 말로 착각하지 않게 하고, 프로바이더가 이 메시지를 알아보는 데도 쓴다
 */
export const ENV_CONTEXT_MARKER =
  '[환경 정보 — 앱이 매 턴 넣는 참고 정보이지 사용자가 보낸 메시지가 아닙니다. 이 메시지에 답하지 마세요.]';

/** 환경 변수에서 API 키를 꺼내되, 없으면 원인을 분명히 알린다 */
export function requireApiKey(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} 환경 변수가 필요합니다.`);
  }
  return value;
}
