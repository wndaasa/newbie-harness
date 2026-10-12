// 도구 실행 행의 표시 텍스트 유틸.
// 실행 중 UI(controller)와 세션 복원(storage)이 같은 라벨을 쓰도록 공용화함.

/** mcp__<서버>__<도구> 이름을 "서버 · 도구"로 분해. MCP 도구가 아니면 undefined */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : undefined;
}

/** 도구 실행 행의 라벨 ("● 파일 읽기" 형태로 표시됨) */
export function toolRowLabel(name: string): string {
  const mcp = parseMcpToolName(name);
  if (mcp) return `MCP · ${mcp.server}`;

  switch (name) {
    case 'read_file':
      return '파일 읽기';
    case 'list_files':
      return '목록 조회';
    case 'get_file_info':
      return '파일 정보';
    case 'parse_document':
      return '문서 변환';
    case 'create_file':
      return '파일 생성';
    case 'edit_file':
      return '파일 편집';
    case 'delete_file':
      return '파일 삭제';
    case 'search_files':
      return '파일 검색';
    case 'run_git':
      return 'git 조회';
    case 'web_search':
      return '웹 검색';
    case 'web_fetch':
      return '웹 페이지 읽기';
    case 'run_command':
      return '명령 실행';
    case 'start_process':
      return '백그라운드 실행';
    case 'read_process':
      return '프로세스 출력';
    case 'stop_process':
      return '프로세스 종료';
    case 'capture_page':
      return '화면 캡처';
    case 'worktree_list':
      return '워크트리 목록';
    case 'worktree_add':
      return '워크트리 생성';
    case 'worktree_remove':
      return '워크트리 제거';
    case 'search_tools':
      return '도구 검색';
    case 'load_tools':
      return '도구 불러오기';
    case 'spawn_agent':
      return '보조 에이전트';
    default:
      return name;
  }
}

/** 보조 에이전트 종류의 표시 이름 */
export function subagentKindLabel(type: unknown): string {
  return type === 'general' ? '일반' : '탐색';
}

/** 제목이 이보다 길면 자른다 — 한 줄 요약이지 설명문이 아니다 */
const MAX_TITLE_CHARS = 80;

/**
 * 도구 실행 행의 제목. 모델이 description을 줬으면("bun 설치 여부 확인") 그것을,
 * 없으면 도구 이름 라벨("명령 실행")을 쓴다.
 *
 * "명령 실행"만으로는 접힌 목록에서 무엇을 했는지 알 수 없어 매번 펼쳐 봐야
 * 했다. 모델이 붙인 한 줄이 제목이 되면 훑기만 해도 흐름이 읽힌다.
 */
export function toolRowTitle({ name, input }: { name: string; input: Record<string, unknown> }): string {
  const description = typeof input.description === 'string' ? input.description : '';
  const oneLine = description.replace(/\s+/g, ' ').trim();
  if (!oneLine) return toolRowLabel(name);
  return oneLine.length > MAX_TITLE_CHARS ? `${oneLine.slice(0, MAX_TITLE_CHARS - 1)}…` : oneLine;
}

/** 도구 실행 행의 대상 표시 (경로·명령·검색어 등) */
export function toolRowTarget({ name, input }: { name: string; input: Record<string, unknown> }): string {
  const mcp = parseMcpToolName(name);
  // MCP 도구는 인자 이름이 서버마다 달라 대상 대신 도구 이름을 보여줌
  if (mcp) return shortenForStatus(mcp.tool, 60);

  if (name === 'run_command' || name === 'start_process') return shortenForStatus(input.command, 60);
  if (name === 'read_process' || name === 'stop_process') return shortenForStatus(input.id, 60);
  if (name === 'capture_page') return shortenForStatus(input.url ?? input.path, 60);
  if (name === 'spawn_agent') return subagentKindLabel(input.type);
  if (name === 'run_git') return shortenForStatus(`git ${input.args ?? ''}`, 60);
  if (name === 'web_search') return shortenForStatus(input.query, 60);
  if (name === 'web_fetch') return shortenForStatus(input.url, 60);
  if (name === 'search_files') {
    return shortenForStatus(input.query ?? input.glob ?? input.path, 60);
  }
  return shortenForStatus(input.path, 60);
}

function shortenForStatus(value: unknown, maxLength = 48): string {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `...${text.slice(-(maxLength - 3))}`;
}
