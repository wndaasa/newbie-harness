// 지연 도구를 찾아서 불러오는 도구.
//
// MCP 서버를 붙이면 그 도구 정의가 요청마다 통째로 나간다. Notion 하나만 붙여도
// 전체 32k 중 30k가 그 서버 몫이고, 웹페이지를 만드는 대화에서도 회의록 조회
// 사용법이 매 라운드 실려 나간다. 캐시가 걸려도 분당 토큰 한도에는 그대로 잡혀서
// 실제로 429가 났다.
//
// 모델은 목록에 없는 도구를 부를 수 없으니 "필요할 때만 보낸다"는 건 순환처럼
// 보이지만, 찾는 행위 자체를 도구로 만들면 풀린다. 여기서는 이름과 짧은 설명만
// 돌려주고, 전체 정의는 불러온 뒤에야 목록에 올라간다.

import { getDeferredTools, loadDeferredTools, registerTool } from '../registry.ts';
import type { ToolDef } from '../registry.ts';

/** 검색 결과 한 건에 보여줄 설명 길이. 길면 아낀 만큼 도로 나간다 */
const SUMMARY_CHARS = 160;

const MAX_RESULTS = 10;

/** 설명의 첫 문단만 잘라 한 줄 요약으로 */
export function summarizeDescription(description: string): string {
  const firstBlock = String(description ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  return firstBlock.length > SUMMARY_CHARS
    ? `${firstBlock.slice(0, SUMMARY_CHARS)}…`
    : firstBlock;
}

/**
 * 조사. "notion에서", "페이지를"처럼 붙어 오면 낱말이 안 맞는다.
 *
 * 형태소 분석기를 붙일 일은 아니다 — 검색 대상이 도구 수십 개고, 떼어낸 결과가
 * 이상해도 원형을 함께 후보로 남기므로 손해가 없다.
 */
const PARTICLES = [
  '에서', '에게', '으로', '까지', '부터', '이나', '라도',
  '에', '을', '를', '의', '로', '은', '는', '이', '가', '와', '과', '도', '만',
];

/**
 * 한국어 질의 ↔ 영문 도구 설명을 잇는 대응표.
 *
 * MCP 서버의 도구 이름과 설명은 대개 영문인데 사용자는 한국어로 시킨다. 실제로
 * "Notion에서 페이지 검색"이 한 번에 안 걸리고 모델이 영어로 바꿔 재검색했다.
 * 흔한 낱말만 이어 준다.
 */
const SYNONYMS: Record<string, string[]> = {
  검색: ['search', 'find', 'query'],
  댓글: ['comment'],
  데이터베이스: ['database', 'data source', 'collection'],
  만들기: ['create', 'new'],
  메일: ['mail', 'email'],
  목록: ['list'],
  문서: ['document', 'page', 'doc'],
  변경: ['update', 'edit', 'change'],
  복제: ['duplicate', 'copy'],
  사용자: ['user', 'people', 'member'],
  삭제: ['delete', 'remove', 'trash'],
  생성: ['create', 'new'],
  수정: ['update', 'edit', 'patch'],
  이동: ['move'],
  일정: ['event', 'calendar', 'schedule'],
  조회: ['get', 'fetch', 'query', 'read', 'list'],
  캘린더: ['calendar', 'event'],
  파일: ['file', 'attachment', 'upload'],
  페이지: ['page'],
  폴더: ['folder'],
  회의록: ['meeting', 'notes'],
  노션: ['notion'],
};

function stripParticle(token: string): string {
  for (const particle of PARTICLES) {
    if (token.length > particle.length + 1 && token.endsWith(particle)) {
      return token.slice(0, -particle.length);
    }
  }
  return token;
}

/**
 * 질의를 검색어 목록으로 편다.
 *
 * 라틴 문자와 한글이 붙어 있으면(`notion에서`) 나눈다. 나눈 뒤 조사를 떼고,
 * 대응표에 있으면 영문 낱말을 함께 넣는다. 원형도 남겨 두므로 떼어내기가
 * 빗나가도 원래 낱말로 걸린다.
 */
export function toSearchTerms(query: string): string[] {
  const raw = String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter(Boolean);

  const terms = new Set<string>();
  for (const token of raw) {
    // 라틴·한글 경계로 한 번 더 나눔 (notion에서 → notion, 에서)
    for (const part of token.match(/[a-z0-9]+|[가-힣]+/g) ?? []) {
      if (part.length < 2) continue;
      terms.add(part);

      const stripped = stripParticle(part);
      if (stripped !== part && stripped.length >= 2) terms.add(stripped);

      for (const synonym of SYNONYMS[stripped] ?? SYNONYMS[part] ?? []) {
        terms.add(synonym);
      }
    }
  }
  return [...terms];
}

/**
 * 질의와 도구의 관련도. 이름이 맞으면 크게, 서버 이름과 설명은 그보다 작게.
 *
 * 서버 이름을 함께 보는 이유: "노션 도구 있어?"처럼 서비스만 대는 경우가 흔한데,
 * 도구 이름에 서버가 접두어로 들어 있어도 낱말이 정확히 겹치지 않을 수 있다.
 */
export function scoreTool(tool: ToolDef, terms: string[]): number {
  if (terms.length === 0) return 1;

  const name = tool.name.toLowerCase();
  const source = (tool.source ?? '').toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (name.includes(term)) score += 3;
    else if (source && source.includes(term)) score += 2;
    else if (description.includes(term)) score += 1;
  }
  return score;
}

export function searchDeferredTools(query: string): ToolDef[] {
  const terms = toSearchTerms(query);

  return getDeferredTools()
    .map(tool => ({ score: scoreTool(tool, terms), tool }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map(entry => entry.tool);
}

registerTool({
  name: 'search_tools',
  chat: true,
  kind: 'read',
  description:
    '지금 목록에 없는 도구를 찾습니다. 외부 서비스(Notion 등) 작업이 필요한데 관련 도구가 안 보이면 먼저 이 도구로 찾고, load_tools로 불러온 뒤 호출하세요. 하려는 일을 그대로 적으면 됩니다.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '하려는 일 또는 도구 이름 (예: "노션 페이지 생성")' },
    },
    required: ['query'],
  },
  execute({ query }) {
    const all = getDeferredTools();
    if (all.length === 0) {
      return '불러올 수 있는 도구가 없습니다. 지금 목록에 있는 도구가 전부입니다.';
    }

    const matches = searchDeferredTools(query);
    if (matches.length === 0) {
      const servers = [...new Set(all.map(tool => tool.source ?? '알 수 없음'))];
      return [
        `"${query}"에 맞는 도구를 찾지 못했습니다.`,
        `연결된 서버: ${servers.join(', ')} (총 ${all.length}개 도구)`,
        '다른 낱말로 다시 검색해 보세요.',
      ].join('\n');
    }

    return [
      `${matches.length}개를 찾았습니다. load_tools로 불러온 뒤 호출하세요.`,
      '',
      ...matches.map(tool => `- ${tool.name}\n    ${summarizeDescription(tool.description)}`),
    ].join('\n');
  },
});

registerTool({
  name: 'load_tools',
  chat: true,
  kind: 'read',
  description:
    'search_tools로 찾은 도구를 사용할 수 있게 불러옵니다. 불러온 도구는 다음 호출부터 쓸 수 있습니다. 실제로 쓸 것만 불러오세요.',
  parameters: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        description: '불러올 도구 이름 목록',
        items: { type: 'string' },
      },
    },
    required: ['names'],
  },
  execute({ names }) {
    const list = Array.isArray(names) ? names : [names];
    const { loaded, rejected } = loadDeferredTools(list.map(String));

    const lines: string[] = [];
    if (loaded.length) {
      lines.push(`불러왔습니다: ${loaded.join(', ')}`, '이제 바로 호출할 수 있습니다.');
    }
    if (rejected.length) {
      lines.push(
        '불러오지 못한 것:',
        ...rejected.map(entry => `  ${entry.name} — ${entry.reason}`),
      );
    }
    return lines.join('\n') || '불러올 도구 이름이 비어 있습니다.';
  },
});
