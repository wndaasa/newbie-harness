// OpenAI Responses API 변환.
//
// gpt-5 계열은 /v1/chat/completions에서 tools와 추론을 함께 받지 않는다. 실측으로
// reasoning_effort를 생략해도, low·medium을 줘도 전부 400이고 'none'만 통과했다 —
// 즉 그 경로에서는 도구를 쓰는 순간 추론이 꺼진 모델로 돌게 된다. 오류 메시지가
// 말하는 대로 /v1/responses로 보내면 추론을 켠 채 도구를 쓸 수 있다.
//
// 세션 이력은 여전히 chat 포맷(expandToolHistory·toOpenAIMessages 결과)이다. 저장
// 포맷을 바꾸면 세션 도중 프로바이더를 바꿀 수 없게 되므로, 호출 직전에 여기서만
// Responses 입력 항목으로 바꾼다.

import type { InternalMessage } from './images.ts';
import { supportsAnthropicEffort } from './anthropicModels.ts';
import { EFFORT_ORDER, cachedAnthropicModelInfo } from './modelCapabilities.ts';

export const DEFAULT_REASONING_EFFORT = 'medium';
const REASONING_EFFORTS = new Set<string>(EFFORT_ORDER);

/** OPENAI_REASONING_EFFORT 값. 모르는 값이면 기본값 — 400으로 턴이 죽는 것보다 낫다 */
export function resolveReasoningEffort(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  return REASONING_EFFORTS.has(value) ? value : DEFAULT_REASONING_EFFORT;
}

/**
 * 저장된 추론 강도를 제공자가 받는 값으로 맞춘다. 강도는 세션에 하나만 저장되므로
 * OpenAI에서 고른 값이 제공자를 바꾼 뒤에도 남는다. 그 값을 그대로 보내면 400이 난다.
 *
 * - Anthropic: 모델이 받는 단계는 Models API의 capabilities.effort로 조회한다
 *   (xhigh·max까지 받는 모델이 있다). 조회 전이면 low·medium·high만 쓴다. "끔"은
 *   effort 값이 아니라서 받는 단계 중 가장 낮은 것으로 보낸다
 * - Ollama: 단계 이름은 모델이 정한다(gpt-oss는 low·medium·high). 모르는 이름은
 *   모델 기본값으로 처리되므로 이 셋으로 맞춰 보낸다
 * - llama.cpp: 채팅 템플릿의 enable_thinking으로 켜고 끄는 것만 된다
 * - vLLM: vllmReasoning이 템플릿 값으로 옮기며, 끔·낮음·중간·높음을 구분한다
 */
export function effortForProvider(provider: string, raw: string | undefined, model = ''): string {
  const effort = resolveReasoningEffort(raw);
  // OpenAI는 .env로 고른 minimal·xhigh를 그대로 보내야 하므로 메뉴 목록으로 맞추지 않는다
  if (provider === 'openai') return effort;
  const levels = effortLevelsFor(provider, model);
  // Anthropic 모델을 모를 때(빈 목록)도 "끔"·minimal을 그대로 내보내지 않게 기본 단계로 맞춘다
  if (provider === 'anthropic' && !levels.length) return clampEffort(effort, ['low', 'medium', 'high']);
  return clampEffort(effort, levels);
}

/**
 * 제공자·모델이 실제로 구분하는 강도 단계 (EFFORT_ORDER 순). 노력 메뉴와
 * effortForProvider가 같은 목록을 쓰므로, 메뉴에 보이는 값이 곧 요청에 실리는 값이다
 */
export function effortLevelsFor(provider: string, model = ''): string[] {
  if (provider === 'anthropic') {
    const fetched = cachedAnthropicModelInfo(model)?.efforts ?? [];
    if (fetched.length) return fetched;
    return supportsAnthropicEffort(model) ? ['low', 'medium', 'high'] : [];
  }
  if (provider === 'ollama' || provider === 'vllm') return ['none', 'low', 'medium', 'high'];
  if (provider === 'llamacpp') return ['none', 'medium'];
  // OpenAI는 모델별로 받는 단계를 알려 주는 API가 없다. minimal·xhigh는 모델에 따라
  // 400이라 메뉴에서 빼고 .env(OPENAI_REASONING_EFFORT)로만 고르게 둔다
  return ['none', 'low', 'medium', 'high'];
}

/**
 * 고른 강도를 받는 단계 중 가장 가까운 것으로 맞춘다. 거리가 같으면 낮은 쪽 —
 * 생각을 더 시켜 비용과 시간이 느는 쪽보다 덜 시키는 쪽이 덜 놀랍다.
 * 단 "끔"은 사용자가 끔을 골랐을 때만 돌려준다. minimal이 끔과 low 사이에서
 * 끔으로 떨어지면 생각을 아예 꺼 버리는 셈이라서다
 */
function clampEffort(effort: string, levels: string[]): string {
  if (!levels.length || levels.includes(effort)) return effort;
  const order: readonly string[] = EFFORT_ORDER;
  const target = order.indexOf(effort);
  const thinking = levels.filter(level => level !== 'none');
  const candidates = effort === 'none' || !thinking.length ? levels : thinking;
  // "끔"을 받지 않는 모델에서 끔을 고르면 가장 낮은 단계가 가장 가깝다
  let best = candidates[0];
  let bestDistance = Infinity;
  for (const level of candidates) {
    const distance = Math.abs(order.indexOf(level) - target);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

export function isReasoningEffort(value: unknown): value is string {
  return typeof value === 'string' && REASONING_EFFORTS.has(value);
}

/** 강도 단계별 메뉴 문구. 어떤 단계를 보일지는 effortLevelsFor가 정한다 */
const EFFORT_LABELS: Record<string, { label: string; hint: string }> = {
  none: { label: '끔', hint: '생각 없이 바로 답합니다. 가장 빠르지만 복잡한 작업에서 실수가 늘어납니다.' },
  minimal: { label: '최소', hint: '아주 짧게만 생각합니다.' },
  low: { label: '낮음', hint: '짧게 생각하고 답합니다. 단순한 질문·수정에 알맞습니다.' },
  medium: { label: '중간', hint: '속도와 정확도의 균형. 기본값입니다.' },
  high: { label: '높음', hint: '더 철저하게 생각합니다. 시간이 더 걸리고 토큰을 더 씁니다.' },
  xhigh: { label: '매우 높음', hint: '어려운 문제를 오래 생각합니다. 시간과 토큰을 많이 씁니다.' },
  max: { label: '최대', hint: '모델이 낼 수 있는 가장 깊은 생각. 가장 느리고 비쌉니다.' },
};

export type ReasoningEffortOption = { value: string; label: string; hint: string };

/** 노력 메뉴에 보여줄 선택지. 제공자·모델이 구분하는 단계만 담는다 */
export function reasoningEffortOptions(provider: string, model = ''): ReasoningEffortOption[] {
  return effortLevelsFor(provider, model).map(value => ({ value, ...EFFORT_LABELS[value] }));
}

/** 모든 단계의 문구. 알림 문구처럼 제공자와 무관하게 이름만 필요할 때 쓴다 */
export function effortLabel(value: string): string {
  return EFFORT_LABELS[value]?.label ?? value;
}

/**
 * 앱을 켤 때 렌더러에 주는 기본 목록. 칸마다 실제 목록은 session-meta 이벤트의
 * reasoningEfforts로 다시 온다
 */
export const REASONING_EFFORT_OPTIONS = reasoningEffortOptions('openai');

type ChatFunctionTool = {
  type?: string;
  function?: { name: string; description?: string; parameters?: unknown };
};

/** chat 포맷 도구 정의({type, function: {...}}) → Responses의 평면 포맷 */
export function toResponsesTools(tools: unknown[]) {
  return tools.map(tool => {
    const chat = tool as ChatFunctionTool;
    if (chat.type !== 'function' || !chat.function) return tool;
    return {
      type: 'function',
      name: chat.function.name,
      description: chat.function.description,
      parameters: chat.function.parameters,
    };
  });
}

type ChatToolCall = { id: string; function: { name: string; arguments?: string } };
type ChatContentPart = {
  type?: string;
  text?: string;
  image_url?: { url?: string };
};

/**
 * chat 포맷 메시지 → Responses input 항목.
 *
 * - assistant.tool_calls → function_call 항목. 항목 id는 싣지 않는다 — id가 있으면
 *   API가 짝이 되는 reasoning 항목까지 요구하는데 세션은 그것을 저장하지 않는다.
 *   call_id만으로 왕복이 성립하는 것은 실측으로 확인했다.
 * - role: tool → function_call_output
 * - 이미지가 든 user content 배열 → input_text / input_image
 * - system/developer 메시지는 instructions 인자로 따로 가므로 건너뛴다
 */
export function toResponsesInput(messages: InternalMessage[]) {
  const items: unknown[] = [];

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') continue;

    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id ?? ''),
        output: String(message.content ?? ''),
      });
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content) items.push({ role: 'assistant', content: String(message.content) });
      const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as ChatToolCall[]) : [];
      for (const call of toolCalls) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments ?? '{}',
        });
      }
      continue;
    }

    if (Array.isArray(message.content)) {
      items.push({
        role: 'user',
        content: (message.content as ChatContentPart[]).map(toInputPart),
      });
      continue;
    }
    items.push({ role: 'user', content: String(message.content ?? '') });
  }

  return items;
}

function toInputPart(part: ChatContentPart) {
  if (part.type === 'text') return { type: 'input_text', text: part.text ?? '' };
  if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url };
  return part;
}
