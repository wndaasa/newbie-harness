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

export const DEFAULT_REASONING_EFFORT = 'medium';
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/** OPENAI_REASONING_EFFORT 값. 모르는 값이면 기본값 — 400으로 턴이 죽는 것보다 낫다 */
export function resolveReasoningEffort(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  return REASONING_EFFORTS.has(value) ? value : DEFAULT_REASONING_EFFORT;
}

export function isReasoningEffort(value: unknown): value is string {
  return typeof value === 'string' && REASONING_EFFORTS.has(value);
}

/**
 * 노력 메뉴(UI)에 보여줄 선택지. API가 받는 값 전체보다 좁다 — minimal·xhigh는
 * 모델에 따라 400이라 메뉴에서 빼고 .env로만 고를 수 있게 둔다.
 */
export const REASONING_EFFORT_OPTIONS = [
  { value: 'none', label: '끔', hint: '생각 없이 바로 답합니다. 가장 빠르지만 복잡한 작업에서 실수가 늘어납니다.' },
  { value: 'low', label: '낮음', hint: '짧게 생각하고 답합니다. 단순한 질문·수정에 알맞습니다.' },
  { value: 'medium', label: '중간', hint: '속도와 정확도의 균형. 기본값입니다.' },
  { value: 'high', label: '높음', hint: '더 철저하게 생각합니다. 시간이 더 걸리고 토큰을 더 씁니다.' },
];

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
