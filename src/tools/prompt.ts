/**
 * 도구 힌트를 텍스트로 반환함.
 *
 * 내장 도구의 설명은 tool definitions(JSON)로 나가므로 여기서 되풀이하지 않는다.
 * 예전에는 tool_use 미지원 제공자용으로 내장 도구 설명을 산문으로 함께 실었는데, 지금은
 * 여섯 제공자 전부 정의를 보내 같은 설명이 두 번(약 1,500토큰) 나갔다. 여기에는
 * 정의에 담을 수 없는 것만 둔다 — 승인 정책, MCP 도구 이름, 목록에 없는 도구 안내.
 */
import { getDeferredTools, getSourcedTools, getToolMode } from './registry.ts';
import type { ToolDef, ToolFilter, ToolMode } from './registry.ts';

/**
 * mode는 기본이 지금 화면의 탭이다. 서브에이전트처럼 화면과 무관하게 도는 루프는
 * 자기 모드를 직접 준다. allow를 주면 그 도구만 안내에 남는다 — 지연 내장 도구는
 * 이름으로 바로 부르니 허용된 것의 시그니처는 남기고, MCP 지연 도구 안내는 뺀다
 * (부분집합만 쓰는 루프는 search_tools도 없어 불러올 길이 없다)
 */
export function buildToolHint(mode: ToolMode = getToolMode(), allow?: ToolFilter): string {
  const builtin = mode === 'chat' ? chatToolHint() : builtinToolHint();
  return [...builtin, ...mcpToolHint(mode, allow), ...deferredToolHint(mode, allow)].join('\n');
}

/*
 * 채팅 모드의 도구 안내.
 *
 * 코딩 도구 설명은 6천 자가 넘는데, 요청마다 통째로 다시 나간다. 날씨를 묻는
 * 대화에도 edit_file 사용법이 매 라운드 실려 나가면 그만큼이 계속 비용이다.
 * 채팅에서 쓸 수 있는 것만 남긴다 — 레지스트리의 모드 필터와 짝을 이룬다.
 */
function chatToolHint(): string[] {
  return [
    '다음 도구를 사용할 수 있음:',
    '  web_search(query) - 웹 검색. 최신 뉴스·버전·가격 등 학습 데이터에 없는 정보가 필요할 때 사용하고, 답변에 출처 URL을 포함할 것',
    '  web_fetch(url) - URL의 페이지·문서를 텍스트로 가져옴. 검색 결과의 링크 내용 확인이나 사용자가 준 URL을 읽을 때 사용할 것',
    '아는 것으로 답할 수 있으면 도구를 쓰지 말 것. 확실하지 않거나 최신 정보가 필요할 때만 검색할 것.',
    '  read_file(path) - 텍스트 파일 읽기. parse_document(path, pages?, pattern?, offset?, limit?) - hwp·hwpx·pdf·xlsx·xls·docx를 마크다운으로. 긴 문서는 개요부터 오니 그걸 보고 pattern이나 offset으로 필요한 부분만 읽을 것. 메시지 끝의 "첨부 파일:" 경로는 답하기 전에 읽을 것',
    '이 모드에는 파일 수정·셸 도구가 없다. 코드를 고치거나 실행해야 하는 일은 코딩 탭에서 하도록 안내할 것.',
  ];
}

// MCP 서버 도구는 연결 후에야 알 수 있어 매번 레지스트리에서 다시 만든다.
// 설명과 인자 스키마는 tool definitions로 이미 나가므로 여기에는 서버별 이름만
// 적는다. 설명까지 되풀이하면 서버 하나에 수천 자가 매 요청 두 번 실린다
function mcpToolHint(mode: ToolMode, allow?: ToolFilter): string[] {
  const tools = getSourcedTools(mode, allow);
  if (tools.length === 0) return [];

  const byServer = new Map<string, string[]>();
  for (const tool of tools) {
    const server = tool.source ?? '';
    byServer.set(server, [...(byServer.get(server) ?? []), tool.name]);
  }

  return [
    '',
    '연결된 MCP 서버 도구:',
    ...[...byServer].map(([server, names]) => `  ${server}: ${names.join(', ')}`),
    'MCP 도구는 외부 서비스를 바꿀 수 있어 읽기 전용으로 표시된 것만 바로 실행됨. 나머지는 실행 전 승인 판정을 거침.',
  ];
}

/**
 * 지연 도구의 한 줄 시그니처 — 이름(필수, 선택?).
 *
 * 내장 지연 도구는 정의(스키마)가 목록에 없을 뿐 이름으로 바로 실행된다
 * (dispatchTool은 지연 여부를 보지 않는다). 인자 이름만 알려 주면 모델이 search_tools
 * 없이 그대로 부를 수 있다 — 스키마 전체를 싣는 것의 1/10 분량이다.
 */
function signatureOf(tool: ToolDef): string {
  const properties = Object.keys(tool.parameters?.properties ?? {});
  const required = new Set(tool.parameters?.required ?? []);
  const args = properties.map(name => (required.has(name) ? name : `${name}?`));
  return `${tool.name}(${args.join(', ')})`;
}

// 정의가 무거운 서버의 도구와 드물게 쓰는 내장 도구는 목록에 올리지 않는다.
// 존재만 알려서 필요할 때 찾아 쓰게 한다 — 이 안내가 없으면 모델은 도구가 있는
// 줄도 모르고 지나간다. 내장 도구는 시그니처를 적어 이름으로 바로 부르게 하고,
// MCP 도구는 스키마가 필요하니 search_tools·load_tools를 거치게 한다.
function deferredToolHint(mode: ToolMode, allow?: ToolFilter): string[] {
  const tools = getDeferredTools(mode);
  const servers = allow ? [] : [...new Set(tools.map(tool => tool.source).filter(Boolean))];
  const builtin = tools.filter(tool => !tool.source && (allow?.(tool.name) ?? true));
  if (builtin.length === 0 && servers.length === 0) return [];

  return [
    '',
    `목록에 올리지 않은 도구가 ${builtin.length + tools.filter(tool => tool.source && !allow).length}개 더 있음. 드물게 쓰거나 정의가 커서 매 요청에 싣지 않는다.`,
    ...(builtin.length
      ? [`내장 (이름으로 바로 호출 가능): ${builtin.map(signatureOf).join(', ')}`]
      : []),
    ...(servers.length
      ? [
          `MCP 서버(${servers.join(', ')})의 도구는 search_tools로 찾고 load_tools로 불러온 뒤 호출할 것.`,
          '목록에 없다고 안 된다고 답하지 말 것. 이 서비스들로 무엇이 가능한지 질문받으면 먼저',
          'search_tools로 확인하고, 검색해도 없을 때만 없다고 답할 것.',
        ]
      : []),
  ];
}

function builtinToolHint(): string[] {
  return [
    '파일 쓰기·셸 실행 도구는 사용자의 권한 모드에 따라 실행 전 승인을 요구하거나 거부될 수 있음. 거부되면 강행하지 말고 이유를 확인할 것.',
    '사용자가 파일·코드·디렉터리·최신 정보에 대해 물어보면 해당 도구를 활용하세요.',
  ];
}
