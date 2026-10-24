// Anthropic 모델별 판정. anthropic.ts와 openaiResponses.ts가 함께 쓰므로 순환 import를
// 피하려고 따로 둔다.

import { cachedAnthropicModelInfo } from './modelCapabilities.ts';

/**
 * output_config.effort를 받는 모델인가. Models API로 조회한 값이 있으면 그것을 쓰고,
 * 조회 전이거나 실패했으면 이름 규칙으로 판정한다(Opus 4.5 이후, Sonnet 4.6 이후,
 * Haiku 5 이후, Fable·Mythos. Haiku 4.5·Sonnet 4.5 이전 모델은 이 필드에 400을 낸다)
 */
export function supportsAnthropicEffort(model: string): boolean {
  const known = cachedAnthropicModelInfo(model)?.effortSupported;
  if (typeof known === 'boolean') return known;
  return /^claude-(opus-4-[5-9]|sonnet-4-[6-9]|(opus|sonnet|haiku)-([5-9]|\d{2,})|fable-|mythos-)/.test(
    model,
  );
}
