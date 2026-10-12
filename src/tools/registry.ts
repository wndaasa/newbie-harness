import type { AgentLoopContext } from '../agent/loop.ts';
import type { Session } from '../session/types.ts';
import type { SessionToolCall } from '../session/storage.ts';

type ToolParameter = {
  type: string;
  description: string;
};

/**
 * 도구 입력 스키마. 자체 도구는 ToolParameter 형태만 쓰지만, MCP 서버 도구는
 * 서버가 준 JSON Schema를 그대로 넘기므로 임의 스키마 조각도 허용한다.
 */
export type ToolParameters = {
  type: 'object';
  properties: Record<string, ToolParameter | Record<string, unknown>>;
  required?: string[];
};

/**
 * 도구 입력 값. 자체 도구는 파라미터를 전부 문자열로 선언하지만 MCP 서버 도구는
 * 중첩 객체·배열도 받기 때문에 값 타입 판단을 각 도구의 스키마에 맡긴다.
 */
export type ToolInput = Record<string, any>;

/** 도구가 하는 일의 종류. 생략하면 read로 취급함 */
export type ToolKind = 'read' | 'write' | 'execute';

/**
 * 승인 사유의 등급.
 *
 * 자동 모드를 코딩 탭 기본값으로 올리면서 생긴 축이다. 이전에는 사유가 붙었는지만
 * 봤고 자동 모드는 그 앞에서 전부 통과시켰는데, 아무도 고르지 않은 기본값이
 * 되는 순간 "고른 사람은 알고 고른 것"이라는 전제가 사라진다.
 *
 * 그렇다고 사유가 붙기만 하면 자동 모드에서도 물어보게 하면, 임시 파일 정리마다
 * 창이 떠서 무인 실행이 불가능해진다(한 번 되돌린 방향이다). 그래서
 * 사유를 두 등급으로 나눠, 되돌릴 수 없거나 바깥으로 나가는 것만 자동 모드를
 * 뚫고 올라오게 한다.
 *
 *   notice:   승인 창이 뜰 때 이유로 보여준다. 자동 모드는 통과시킨다.
 *   classify: 자동 모드에서는 LLM 분류기가 판정해 통과/차단한다.
 *             다른 모드에서는 confirm과 같이 사용자 승인을 받는다.
 *   confirm:  자동 모드에서도 반드시 사용자 승인을 받는다.
 */
export type ApprovalSeverity = 'notice' | 'classify' | 'confirm';

export type ApprovalDecision = { severity: ApprovalSeverity; reason: string } | null;

/** 사유는 보여주되 자동 모드는 막지 않는다 */
export function approvalNotice(reason: string): ApprovalDecision {
  return { reason, severity: 'notice' };
}

/** 자동 모드에서는 분류기 판정, 다른 모드에서는 승인을 받는다 */
export function approvalClassify(reason: string): ApprovalDecision {
  return { reason, severity: 'classify' };
}

/** 자동 모드에서도 승인을 받는다 */
export function approvalConfirm(reason: string): ApprovalDecision {
  return { reason, severity: 'confirm' };
}

/**
 * 도구 결과.
 *
 * 대부분의 도구는 문자열만 돌려주므로 문자열을 그대로 허용한다. 화면을 찍어
 * 보여줘야 하는 도구(스크린샷, MCP 브라우저 도구 등)만 이미지를 함께 싣는다.
 */
export type ToolResult =
  | string
  | { background?: boolean; text: string; images?: string[]; children?: SessionToolCall[] };

/**
 * 정규화된 도구 결과. 루프와 세션 저장은 이 형태만 다룬다.
 * children은 서브에이전트가 안에서 실행한 도구 호출 — 화면에 중첩해 보여주고
 * 세션에 남기되, 모델에게는 text만 간다.
 * background는 도구가 일을 백그라운드로 넘기고 바로 돌아온 것 — 화면의 행은
 * 실제 결과가 올 때까지 running으로 남긴다
 */
export type ToolOutcome = {
  background?: boolean;
  text: string;
  images: string[];
  children?: SessionToolCall[];
};

/**
 * 도구 실행 시점의 컨텍스트. 대부분의 도구는 입력만 보면 되지만, 서브에이전트처럼
 * 루프를 다시 돌리는 도구는 부모의 승인·중단 신호·이벤트 경로를 물려받아야 한다
 */
export type ToolContext = {
  /** 이 도구를 부른 루프의 컨텍스트 */
  agent: AgentLoopContext;
  /** 이 호출의 id. 안에서 생긴 이벤트는 이 id를 parentId로 달고 나간다 */
  callId: string;
  session: Session;
};

/**
 * 도구 결과 한 건에 실을 수 있는 이미지 수.
 *
 * 스크린샷은 턴마다 쌓이고 이력에 계속 남아 컨텍스트를 빠르게 채운다. 사용자
 * 첨부와 같은 기준(4장)으로 맞춰 한 번에 들어오는 양을 제한한다.
 */
const MAX_RESULT_IMAGES = 4;

/** 장당 상한 (base64 문자 수). 약 7MB 이미지에 해당하며 사용자 첨부와 같은 기준 */
const MAX_IMAGE_CHARS = 10_000_000;

const DATA_URL = /^data:image\/[a-z0-9+.-]+;base64,.+$/i;

/**
 * 도구 목록을 어느 모드 기준으로 만들지.
 *
 * 채팅 모드에는 파일·셸 도구를 내보내지 않는다. 안 쓸 도구라서만이 아니라,
 * 도구 정의가 요청마다 통째로 다시 나가기 때문이다. 코딩 도구 정의(설명과 인자 스키마)만 6천 자가
 * 넘어서, 날씨를 묻는 대화에도 edit_file 사용법이 매 라운드 실려 나간다.
 */
export type ToolMode = 'chat' | 'coding';

let toolMode: ToolMode = 'coding';

export function setToolMode(mode: ToolMode): void {
  toolMode = mode;
}

export function getToolMode(): ToolMode {
  return toolMode;
}

/** 도구 이름으로 목록을 더 좁히는 필터 (서브에이전트는 부분집합만 쓴다) */
export type ToolFilter = (name: string) => boolean;

/** 그 모드에서 쓸 수 있는 도구인가 (기본은 지금 화면의 모드) */
function usableInMode(tool: ToolDef, mode: ToolMode = toolMode): boolean {
  if (mode === 'coding') return true;
  // MCP 서버 도구(source 있음)는 코딩과 무관해 채팅에서도 쓴다
  return tool.chat === true || tool.source !== undefined;
}

export type ToolDef = {
  name: string;
  description: string;
  kind?: ToolKind;
  /** 채팅 모드에서도 쓸 수 있는가. 생략하면 코딩 전용 */
  chat?: boolean;
  /**
   * 실행 중에 붙였다 뗄 수 있는 도구의 출처 (MCP 서버 이름). 자체 도구는 비어 있고,
   * 서버 연결이 끊기면 unregisterToolSource로 이 값을 가진 도구만 걷어낸다.
   */
  source?: string;
  /**
   * 이름만 알려두고 정의는 모델에게 보내지 않는 도구.
   *
   * 도구 정의는 요청마다 통째로 다시 나간다. Notion MCP 하나만 붙여도 32k 중
   * 30k가 그 서버 몫이라, 웹페이지를 만드는 대화에서도 회의록 조회 사용법이
   * 매 라운드 실려 나갔다. 캐시가 걸려도 분당 토큰 한도에는 그대로 잡힌다.
   *
   * 이 표시가 붙은 도구는 search_tools로 찾아 load_tools로 불러와야 목록에
   * 올라간다. 루프가 라운드마다 도구 목록을 다시 만들기 때문에, 불러온 즉시
   * 다음 라운드부터 쓸 수 있다.
   */
  deferred?: boolean;
  /**
   * 입력 값에 따라 승인을 받아야 하는지 판단함. kind와는 별개 축이다 —
   * 읽기 도구라도 대상이 자격증명 파일이거나 사설망 주소면 승인이 필요하다.
   * 승인이 필요하면 사용자에게 보여줄 사유를, 아니면 null을 반환한다.
   */
  approvalGate?: (input: ToolInput) => ApprovalDecision;
  parameters: ToolParameters;
  execute: (input: ToolInput, context?: ToolContext) => Promise<ToolResult> | ToolResult;
};

const registry: ToolDef[] = [];

/**
 * 이번 세션에서 불러온 지연 도구 이름.
 *
 * 턴이 끝날 때 비우지 않는다. 노션 작업을 시작했으면 그 대화 내내 쓸 가능성이
 * 높고, 매 턴 다시 찾게 하면 왕복만 늘어난다. 대신 상한을 둬서 무한정 쌓이지는
 * 않게 한다.
 */
const loaded = new Set<string>();

/** 한 세션에서 불러올 수 있는 지연 도구 수 */
const MAX_LOADED_TOOLS = 20;

export function registerTool(def: ToolDef) {
  registry.push(def);
}

/**
 * 모델에게 보낼 도구. 모드에 안 맞거나 아직 불러오지 않은 지연 도구는 빠진다.
 * mode를 받는 이유: 전역 toolMode는 지금 화면의 탭을 따라가는데, 백그라운드에서
 * 도는 코딩 턴은 화면이 채팅 탭으로 가 있어도 파일·셸 도구를 계속 써야 한다
 */
function availableTools(mode: ToolMode = toolMode, allow?: ToolFilter): ToolDef[] {
  return registry.filter(
    tool =>
      usableInMode(tool, mode) &&
      (!tool.deferred || loaded.has(tool.name)) &&
      (allow?.(tool.name) ?? true),
  );
}

/** source가 같은 도구를 모두 제거하고 제거한 개수를 반환 (MCP 서버 연결 해제용) */
export function unregisterToolSource(source: string): number {
  let removed = 0;
  for (let i = registry.length - 1; i >= 0; i -= 1) {
    if (registry[i].source === source) {
      loaded.delete(registry[i].name);
      registry.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

/** 동적으로 등록된 도구 (MCP 서버 도구). 도구 힌트 생성용 */
export function getSourcedTools(mode?: ToolMode, allow?: ToolFilter): ToolDef[] {
  return availableTools(mode, allow).filter(tool => tool.source);
}

/** 아직 불러오지 않은 지연 도구 (search_tools의 검색 대상) */
export function getDeferredTools(mode?: ToolMode): ToolDef[] {
  return registry.filter(
    tool => usableInMode(tool, mode) && tool.deferred && !loaded.has(tool.name),
  );
}

/**
 * 지연 도구를 목록에 올린다. 다음 라운드부터 모델이 호출할 수 있다.
 * 이름이 잘못됐거나 상한에 걸린 것은 따로 알려 모델이 다시 시도하게 한다.
 */
export function loadDeferredTools(names: string[]): {
  loaded: string[];
  rejected: { name: string; reason: string }[];
} {
  const accepted: string[] = [];
  const rejected: { name: string; reason: string }[] = [];

  for (const raw of names) {
    const name = String(raw ?? '').trim();
    const tool = registry.find(entry => entry.name === name);

    if (!tool) {
      rejected.push({ name, reason: '그런 도구가 없습니다' });
    } else if (!tool.deferred || loaded.has(name)) {
      // 이미 쓸 수 있는 도구를 부른 것이라 실패는 아니다
      accepted.push(name);
    } else if (loaded.size >= MAX_LOADED_TOOLS) {
      rejected.push({ name, reason: `한 번에 ${MAX_LOADED_TOOLS}개까지만 불러올 수 있습니다` });
    } else {
      loaded.add(name);
      accepted.push(name);
    }
  }

  return { loaded: accepted, rejected };
}

/** 테스트·세션 전환용 */
export function clearLoadedTools(): void {
  loaded.clear();
}

export function hasTool(name: string): boolean {
  return registry.some(tool => tool.name === name);
}

/** Anthropic tool_use 포맷으로 변환 */
export function getAnthropicTools(mode?: ToolMode, allow?: ToolFilter) {
  return availableTools(mode, allow).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/** OpenAI 호환 포맷으로 변환 (Ollama, LM Studio 포함) */
export function getOpenAITools(mode?: ToolMode, allow?: ToolFilter) {
  return availableTools(mode, allow).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function dispatchTool(
  name: string,
  input: ToolInput,
  context?: ToolContext,
): Promise<ToolOutcome> {
  const tool = registry.find(t => t.name === name);
  if (!tool) throw new Error(`알 수 없는 도구: ${name}`);
  return normalizeToolResult(await tool.execute(input, context));
}

/**
 * 도구가 무엇을 돌려주든 { text, images } 한 형태로 맞춘다.
 *
 * 여기서 이미지 수·크기를 걸러 두면 이후 경로(루프, 세션 저장, 프로바이더 변환)는
 * 값이 성한지 다시 확인하지 않아도 된다.
 */
export function normalizeToolResult(result: ToolResult): ToolOutcome {
  if (typeof result === 'string') return { images: [], text: result };

  const images = (result.images ?? [])
    .filter(image => typeof image === 'string' && DATA_URL.test(image))
    .filter(image => image.length <= MAX_IMAGE_CHARS)
    .slice(0, MAX_RESULT_IMAGES);

  return {
    ...(result.background ? { background: true } : {}),
    images,
    text: String(result.text ?? ''),
    ...(result.children?.length ? { children: result.children } : {}),
  };
}

export function getToolKind(name: string): ToolKind {
  return registry.find(t => t.name === name)?.kind ?? 'read';
}

/** 이번 호출이 승인을 요구하는지와 그 사유·등급. 필요 없으면 null */
export function getToolApprovalDecision(
  name: string,
  input: ToolInput,
): ApprovalDecision {
  const tool = registry.find(t => t.name === name);
  if (!tool?.approvalGate) return null;
  try {
    return tool.approvalGate(input);
  } catch {
    // 게이트 판단이 실패하면 안전한 쪽으로 기운다. 입력을 해석하지 못한 것이라
    // 무엇이 실행될지 모르는 상태이므로 자동 모드에서도 물어본다
    return approvalConfirm('입력을 확인할 수 없어 승인이 필요합니다.');
  }
}

/** 승인 창에 띄울 사유 문자열만. 승인이 필요 없으면 null */
export function getToolApprovalReason(name: string, input: ToolInput): string | null {
  return getToolApprovalDecision(name, input)?.reason ?? null;
}
