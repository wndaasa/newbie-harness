import {
  searchWeb,
  type WebSearchResponse,
  type WebSearchResult,
} from '../../websearch/tavily.ts';
import { registerTool } from '../registry.ts';

const SNIPPET_MAX_LENGTH = 700;
// 요약 답변은 제공자가 길이를 정하지 않는다. 출처 본문보다 길어질 이유가 없어 상한을 둔다
const ANSWER_MAX_LENGTH = 1_500;

registerTool({
  name: 'web_search',
  chat: true,
  description: '웹에서 최신 정보를 검색합니다. 학습 데이터에 없거나 최신성이 필요한 내용(뉴스, 버전, 가격, 날짜 등)을 물어보면 사용하세요. 답변에는 검색 결과의 출처 URL을 포함하세요.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '검색어' },
    },
    required: ['query'],
  },
  async execute({ query }) {
    const trimmed = query?.trim();
    if (!trimmed) throw new Error('검색어가 비어 있습니다.');
    return formatSearchResult(await searchWeb(trimmed));
  },
});

function formatSearchResult(result: WebSearchResponse): string {
  const lines = [`검색어: ${result.query}`];

  if (result.answer) {
    lines.push('', `요약 답변: ${truncate(result.answer, ANSWER_MAX_LENGTH)}`);
  }

  lines.push('', '검색 결과:');
  if (result.results.length === 0) {
    lines.push('- 검색 결과가 없습니다.');
  } else {
    lines.push(...result.results.map(formatSource));
  }

  return lines.join('\n');
}

function formatSource(result: WebSearchResult, index: number): string {
  return [
    `[${index + 1}] ${result.title || result.url}`,
    `URL: ${result.url}`,
    result.content ? `내용: ${truncate(result.content, SNIPPET_MAX_LENGTH)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}
