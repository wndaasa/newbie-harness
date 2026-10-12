import type { SessionModelMessage, SessionToolCall } from '../session/storage.ts';

function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const match = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  return { base64: match[2], mediaType: match[1] };
}

/**
 * Anthropic tool_result의 content.
 *
 * 이미지가 없으면 문자열 그대로 두고, 있으면 텍스트·이미지 블록 배열로 만든다.
 * tool_result 안에 이미지 블록을 넣는 것은 Anthropic이 공식으로 받는 형태다.
 */
function anthropicToolResultContent(call: SessionToolCall) {
  if (!call.images?.length) return call.result;

  return [
    ...(call.result ? [{ text: call.result, type: 'text' }] : []),
    ...call.images
      .map(parseDataUrl)
      .filter((image): image is NonNullable<typeof image> => image !== null)
      .map(image => ({
        source: { data: image.base64, media_type: image.mediaType, type: 'base64' },
        type: 'image',
      })),
  ];
}

// 세션에는 도구 이력을 프로바이더 중립 포맷(assistant 메시지의 toolCalls)으로 저장하고,
// 프로바이더 호출 직전에만 각 API가 요구하는 tool 메시지 포맷으로 확장함.
// 덕분에 세션 도중 프로바이더를 바꿔도 이전 도구 이력을 그대로 이어갈 수 있음.
//
// 도구가 돌려준 이미지는 프로바이더마다 실을 수 있는 자리가 달라서 여기서 갈린다.
// Anthropic은 tool_result 안에 이미지 블록을 넣을 수 있지만, OpenAI 계열의
// tool 메시지는 텍스트만 받는다. 그래서 OpenAI 쪽은 도구 결과 직후에 이미지를
// 실은 user 메시지를 따로 붙인다. 이 차이를 저장 포맷이 아니라 확장 시점에서만
// 흡수해야 프로바이더를 바꿔도 이력이 그대로 이어진다.
/** 작업 중 끼어든 사용자 메시지 앞에 붙는 안내. 모델만 본다 (화면·저장은 원문) */
export const INTERJECTION_MARKER =
  '[작업 진행 중에 사용자가 보낸 메시지입니다. 하던 작업의 맥락은 위 이력에 있습니다. ' +
  '이 내용을 반영해 이어가고, 방향을 바꾸라는 뜻이면 그에 따르세요.]';

export function expandToolHistory(
  messages: SessionModelMessage[],
  provider: string,
) {
  const expanded = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      // 본문도 도구 호출도 없는 assistant 메시지는 진단용 기록(빈 라운드의 사고
      // 내용·종료 사유)이다. Anthropic은 빈 본문을 400으로 거부하고, 다른 API도
      // 이것을 "아무것도 안 한 응답"으로 배운다
      if (message.role === 'assistant' && !String(message.content ?? '').trim()) continue;
      // 추론 요약·시각·끼어듦 표식은 화면용이다. 그대로 보내면 API가 모르는
      // 필드로 400을 낸다
      const plain = { ...message };
      delete plain.agentReport;
      delete plain.at;
      delete plain.automatic;
      delete plain.interjected;
      delete plain.readAt;
      delete plain.reasoning;
      delete plain.stopReason;
      // 작업 도중 끼어든 메시지는 그 사실을 모델에게 알린다. 표식이 없으면 모델은
      // 이전 요청이 취소된 줄 알거나, 반대로 새 지시를 흘려 넘긴다
      if (message.interjected && message.role === 'user') {
        plain.content = `${INTERJECTION_MARKER}\n${message.content}`;
      }
      expanded.push(plain);
      continue;
    }

    if (provider === 'anthropic') {
      expanded.push({
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          })),
        ],
      });
      // Anthropic은 tool_result 여럿을 user 메시지 하나에 묶음
      expanded.push({
        role: 'user',
        content: message.toolCalls.map(tc => ({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: anthropicToolResultContent(tc),
        })),
      });
      continue;
    }

    // OpenAI / LM Studio / Ollama: tool 메시지를 개별로
    expanded.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      })),
    });
    for (const tc of message.toolCalls) {
      expanded.push({ role: 'tool', tool_call_id: tc.id, content: tc.result });
    }

    // tool 메시지는 이미지를 못 실으므로, 이미지를 돌려준 도구가 있으면 직후에
    // user 메시지로 이어 붙인다. 어느 도구의 결과인지 텍스트로 밝혀 둬야 모델이
    // 앞의 tool 메시지와 연결지어 읽는다
    const withImages = message.toolCalls.filter(tc => tc.images?.length);
    for (const tc of withImages) {
      expanded.push({
        role: 'user',
        content: `[${tc.name} 도구가 돌려준 이미지]`,
        images: tc.images,
      });
    }
  }
  return expanded;
}
