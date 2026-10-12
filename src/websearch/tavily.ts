const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const DEFAULT_MAX_RESULTS = 5;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_ERROR_BODY_CHARS = 2_000;

export type WebSearchResult = {
  title: string;
  url: string;
  content: string;
  score?: number;
};

export type WebSearchResponse = {
  answer: string;
  credits?: number;
  query: string;
  responseTimeSeconds?: number;
  results: WebSearchResult[];
};

export async function searchWeb(query: string): Promise<WebSearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    // 모델이 이 문장을 사용자에게 그대로 전한다. 설치본 사용자는 환경 변수를 둘 자리가
    // 없으므로 설정창의 위치를 알려 준다
    throw new Error('Tavily API 키가 없습니다. 설정 > 제공자 > 웹 검색에서 키를 입력하세요 (환경 변수 TAVILY_API_KEY도 됩니다).');
  }

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      include_answer: 'basic',
      include_raw_content: false,
      include_images: false,
      include_usage: true,
      max_results: DEFAULT_MAX_RESULTS,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    // 오류 본문은 그대로 UI·세션 기록에 남으므로 길이를 제한함
    const body = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
    throw new Error(`Tavily 검색 실패 (${response.status}): ${body}`);
  }

  return normalizeSearchResponse(await response.json());
}

function normalizeSearchResponse(data: any): WebSearchResponse {
  return {
    answer: String(data.answer ?? '').trim(),
    credits: numberOrUndefined(data.usage?.credits),
    query: String(data.query ?? ''),
    responseTimeSeconds: numberOrUndefined(data.response_time),
    results: Array.isArray(data.results)
      ? data.results.map(normalizeResult).filter((result: WebSearchResult) => result.url)
      : [],
  };
}

function normalizeResult(result: any): WebSearchResult {
  return {
    title: String(result.title ?? result.url ?? 'Untitled'),
    url: String(result.url ?? ''),
    content: String(result.content ?? '').trim(),
    score: numberOrUndefined(result.score),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
