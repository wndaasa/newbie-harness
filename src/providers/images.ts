// 이미지가 첨부된 사용자 메시지를 프로바이더별 멀티모달 포맷으로 변환함.
// 내부 메시지 포맷: { role: 'user', content: string, images?: string[] } — images는 data URL.
// 이미지가 없는 메시지(도구 결과 배열 포함)는 그대로 통과시킴.

export type InternalMessage = {
  content: unknown;
  images?: string[];
  role: string;
  [key: string]: unknown;
};

function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const match = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  return { mediaType: match[1], base64: match[2] };
}

/** Anthropic: content 배열의 image 블록 (base64 source) */
export function toAnthropicMessages(messages: InternalMessage[]) {
  return messages.map(message => {
    if (message.role !== 'user' || !message.images?.length) return message;

    const { images, ...rest } = message;
    return {
      ...rest,
      content: [
        ...images
          .map(parseDataUrl)
          .filter((image): image is NonNullable<typeof image> => image !== null)
          .map(image => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
          })),
        ...(message.content ? [{ type: 'text', text: String(message.content) }] : []),
      ],
    };
  });
}

/** OpenAI·LM Studio: content 배열의 image_url 파트 (data URL 그대로) */
export function toOpenAIMessages(messages: InternalMessage[]) {
  return messages.map(message => {
    if (message.role !== 'user' || !message.images?.length) return message;

    const { images, ...rest } = message;
    return {
      ...rest,
      content: [
        ...(message.content ? [{ type: 'text', text: String(message.content) }] : []),
        ...images.map(url => ({ type: 'image_url', image_url: { url } })),
      ],
    };
  });
}

/** Ollama: message.images에 base64 문자열 배열 (data URL 접두사 제거) */
export function toOllamaMessages(messages: InternalMessage[]) {
  return messages.map(message => {
    if (message.role !== 'user' || !message.images?.length) return message;

    const { images, ...rest } = message;
    return {
      ...rest,
      images: images
        .map(parseDataUrl)
        .filter((image): image is NonNullable<typeof image> => image !== null)
        .map(image => image.base64),
    };
  });
}
