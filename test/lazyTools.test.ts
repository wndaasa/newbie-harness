// 지연 도구 회귀 테스트.
//
// MCP 서버를 붙이면 도구 정의가 요청마다 통째로 나간다. Notion 하나로 32k 중
// 30k가 그 서버 몫이었고, 캐시가 걸려도 분당 토큰 한도에는 그대로 잡혀 429가 났다.
// 정의를 목록에서 빼되 필요할 때 불러올 수 있어야 하고, 두 방향이 모두 깨지면
// 안 된다 — 안 빠지면 절감이 없고, 못 불러오면 그 서비스를 아예 못 쓴다.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearLoadedTools,
  getDeferredTools,
  getOpenAITools,
  loadDeferredTools,
  registerTool,
  unregisterToolSource,
} from '../src/tools/registry.ts';
import {
  scoreTool,
  searchDeferredTools,
  summarizeDescription,
  toSearchTerms,
} from '../src/tools/lazyTools/lazyTools.ts';

// 도구는 import 부수 효과로 등록된다. 자체 도구가 지연 처리에 휩쓸리지 않는지
// 보려면 이 파일만 돌려도 하나는 등록돼 있어야 한다
import '../src/tools/read/readFile.ts';

const SOURCE = 'test-server';

function addDeferred(name: string, description: string) {
  registerTool({
    deferred: true,
    description,
    execute: () => '실행됨',
    name,
    parameters: { properties: {}, required: [], type: 'object' },
    source: SOURCE,
  });
}

afterEach(() => {
  unregisterToolSource(SOURCE);
  clearLoadedTools();
});

describe('지연 도구는 목록에서 빠진다', () => {
  test('등록해도 모델에게 가는 목록에 없다', () => {
    const before = getOpenAITools().length;
    addDeferred('mcp__test__create_page', '페이지를 만듭니다');

    // 여기가 깨지면 절감이 전부 사라진다
    expect(getOpenAITools()).toHaveLength(before);
    expect(getDeferredTools().map(t => t.name)).toContain('mcp__test__create_page');
  });

  test('불러오면 목록에 올라온다', () => {
    const before = getOpenAITools().length;
    addDeferred('mcp__test__create_page', '페이지를 만듭니다');

    loadDeferredTools(['mcp__test__create_page']);

    expect(getOpenAITools()).toHaveLength(before + 1);
    expect(getOpenAITools().map(t => t.function.name)).toContain('mcp__test__create_page');
    // 불러온 도구는 더 이상 검색 대상이 아니다
    expect(getDeferredTools().map(t => t.name)).not.toContain('mcp__test__create_page');
  });

  test('지연이 아닌 도구는 그대로 보인다', () => {
    // 자체 도구가 이 변경에 휩쓸리면 안 된다
    expect(getOpenAITools().map(t => t.function.name)).toContain('read_file');
  });

  test('서버 연결을 끊으면 불러온 것도 정리된다', () => {
    addDeferred('mcp__test__create_page', '페이지를 만듭니다');
    loadDeferredTools(['mcp__test__create_page']);

    unregisterToolSource(SOURCE);

    expect(getOpenAITools().map(t => t.function.name)).not.toContain('mcp__test__create_page');
    expect(getDeferredTools().map(t => t.name)).not.toContain('mcp__test__create_page');
  });
});

describe('불러오기', () => {
  test('없는 이름은 사유와 함께 거부한다', () => {
    const { loaded, rejected } = loadDeferredTools(['없는-도구']);
    expect(loaded).toHaveLength(0);
    expect(rejected[0].reason).toContain('없습니다');
  });

  test('이미 쓸 수 있는 도구는 실패가 아니다', () => {
    // 모델이 자체 도구를 불러오려 해도 오류로 막을 이유가 없다
    const { loaded, rejected } = loadDeferredTools(['read_file']);
    expect(loaded).toEqual(['read_file']);
    expect(rejected).toHaveLength(0);
  });

  test('상한을 넘으면 거부한다', () => {
    for (let i = 0; i < 25; i += 1) addDeferred(`mcp__test__tool_${i}`, `도구 ${i}`);

    const names = Array.from({ length: 25 }, (_, i) => `mcp__test__tool_${i}`);
    const { loaded, rejected } = loadDeferredTools(names);

    expect(loaded).toHaveLength(20);
    expect(rejected).toHaveLength(5);
    expect(rejected[0].reason).toContain('20개');
  });
});

describe('검색', () => {
  test('이름이 맞으면 설명보다 높게 친다', () => {
    const byName = { description: '무관한 설명', name: 'notion_search' } as any;
    const byDescription = { description: 'notion 관련 도구', name: 'other_tool' } as any;
    expect(scoreTool(byName, ['notion'])).toBeGreaterThan(scoreTool(byDescription, ['notion']));
  });

  test('하려는 일로 찾을 수 있다', () => {
    addDeferred('mcp__test__create_page', '노션에 새 페이지를 만듭니다');
    addDeferred('mcp__test__list_users', '사용자 목록을 조회합니다');

    const found = searchDeferredTools('페이지 만들기').map(t => t.name);
    expect(found).toContain('mcp__test__create_page');
    expect(found).not.toContain('mcp__test__list_users');
  });

  test('맞는 게 없으면 빈 배열', () => {
    addDeferred('mcp__test__create_page', '노션에 새 페이지를 만듭니다');
    expect(searchDeferredTools('전혀 상관없는 낱말들')).toHaveLength(0);
  });

  test('요약은 짧게 자른다', () => {
    // 전체 설명을 돌려주면 아낀 만큼 도로 나간다
    const long = `${'긴 설명입니다. '.repeat(50)}`;
    expect(summarizeDescription(long).length).toBeLessThanOrEqual(161);
  });
});

describe('한국어 질의 처리', () => {
  // 실측에서 "Notion에서 페이지 검색"이 한 번에 안 걸리고 모델이 영어로 바꿔
  // 재검색했다. 조사가 붙은 것과 설명이 영문인 것 두 가지가 겹친 문제였다.

  test('라틴 낱말에 붙은 조사를 떼어낸다', () => {
    const terms = toSearchTerms('Notion에서 검색');
    expect(terms).toContain('notion');
  });

  test('한국어 낱말의 조사도 떼어낸다', () => {
    expect(toSearchTerms('페이지를 만들기')).toContain('페이지');
  });

  test('한국어를 영문 낱말로 이어 준다', () => {
    const terms = toSearchTerms('페이지 검색');
    expect(terms).toContain('page');
    expect(terms).toContain('search');
  });

  test('원형도 남긴다', () => {
    // 조사 떼기가 빗나가도 원래 낱말로 걸려야 한다
    expect(toSearchTerms('페이지를')).toContain('페이지를');
  });

  test('실제로 걸리던 질의가 이제 걸린다', () => {
    addDeferred(
      'mcp__test__notion-search',
      "Search the user's Notion workspace and connected sources.",
    );
    addDeferred('mcp__test__list_users', 'List workspace members.');

    // 설명이 영문인데 질의는 한국어인 상황
    const found = searchDeferredTools('Notion에서 페이지 검색').map(t => t.name);
    expect(found[0]).toBe('mcp__test__notion-search');
  });

  test('서버 이름만 대도 찾을 수 있다', () => {
    addDeferred('mcp__test__something', '무관한 설명');
    expect(searchDeferredTools('test-server 도구').map(t => t.name)).toContain(
      'mcp__test__something',
    );
  });
});
