import { registerTool } from '../registry.ts';
import { checkFetchUrl } from './urlGuard.ts';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_CHARS = 20_000;
// 응답 전체를 메모리에 올리지 않도록 읽어들이는 바이트 수를 제한함.
// 어차피 MAX_CONTENT_CHARS로 잘리므로 그보다 넉넉한 값이면 충분하다
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;

export async function webFetchTool(url: string): Promise<string> {
  const trimmed = String(url ?? '').trim();

  // 리다이렉트를 직접 따라가며 매 홉을 검사한다. redirect:'follow'로 두면
  // 공인 주소로 시작해 내부 주소로 넘어가는 경로를 잡을 수 없다.
  let currentUrl = trimmed;
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const rejection = await checkFetchUrl(currentUrl);
    if (rejection) throw new Error(rejection);

    response = await fetch(currentUrl, {
      headers: { 'user-agent': 'newbie-harness (desktop app)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status < 300 || response.status >= 400) break;

    const location = response.headers.get('location');
    if (!location) break;
    // 상대 경로 Location도 허용됨 (RFC 7231)
    currentUrl = new URL(location, currentUrl).toString();
    response = undefined;
  }

  if (!response) {
    throw new Error(`리다이렉트가 너무 많습니다 (최대 ${MAX_REDIRECTS}회): ${trimmed}`);
  }

  if (!response.ok) {
    throw new Error(`요청 실패 (${response.status} ${response.statusText}): ${currentUrl}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/text|json|xml|javascript/i.test(contentType)) {
    throw new Error(`텍스트가 아닌 콘텐츠는 가져올 수 없습니다 (content-type: ${contentType})`);
  }

  const body = await readCapped(response, MAX_RESPONSE_BYTES);
  const text = /html/i.test(contentType) ? htmlToText(body) : body;

  return [
    `URL: ${currentUrl}`,
    `content-type: ${contentType}`,
    '---',
    truncate(text.trim(), MAX_CONTENT_CHARS),
  ].join('\n');
}

// 본문을 스트리밍으로 읽되 상한에 닿으면 중단함. response.text()는 크기와
// 무관하게 전부 메모리에 올린다
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return text;
}

// 본문 텍스트만 추출하는 최소 변환: script/style 제거 → 태그 제거 → 엔티티 복원
function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  return withoutBlocks
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...(내용이 길어 ${value.length - maxLength}자 생략됨)`;
}

registerTool({
  name: 'web_fetch',
  chat: true,
  kind: 'read',
  description:
    'URL의 웹 페이지나 텍스트 문서를 가져와 본문 텍스트를 반환합니다. ' +
    'web_search 결과의 링크 내용을 확인하거나 사용자가 준 URL을 읽을 때 사용하세요. ' +
    'HTML은 태그를 제거한 텍스트로 변환되며, 바이너리 콘텐츠는 가져올 수 없습니다.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '가져올 http/https URL' },
    },
    required: ['url'],
  },
  execute({ url }) {
    return webFetchTool(url);
  },
});
