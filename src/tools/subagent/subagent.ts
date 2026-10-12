// 보조 에이전트 (서브에이전트).
//
// 코드베이스 한 영역을 통째로 훑거나 호출 지점을 전부 찾는 일은 메인 에이전트가
// 파일을 하나씩 읽으면 컨텍스트만 차고 대화가 느려진다. 그 일을 자식 루프에
// 맡기고 결론만 받아 오면, 메인 대화에는 보고서 한 장만 남는다.
//
// 자식은 백그라운드로 돈다. 도구는 "시작했다"만 돌려주고 바로 끝나므로 부모는
// 그동안 자기 일을 이어가고, 자식이 끝나면 보고가 onAgentReport로 나가 부모
// 이력에 자동 알림으로 들어간다 (부모 턴이 이미 끝났으면 컨트롤러가 새 턴을
// 연다). 받을 곳(onAgentReport)이 없는 CLI 단발 실행에서는 예전처럼 기다린다.
//
// 자식은 별도 프로세스가 아니라 같은 프로세스 안의 루프 하나다. 부모의 세션
// 설정(제공자·모델·권한 모드·프로젝트 폴더)을 그대로 물려받고, 승인 창·도구
// 이벤트도 부모 것을 쓴다. 중단은 자식마다 따로 두되 부모 턴의 중단에 이어
// 두고, 부모 턴이 끝난 뒤에는 컨트롤러가 세션 단위로 끊는다 (onAgentStart).

import { runAgentLoop, stopSummary } from '../../agent/loop.ts';
import type { AgentLoopContext, ToolRequest } from '../../agent/loop.ts';
import { buildSubagentSystemPrompt } from '../../config.ts';
import { registerTool } from '../registry.ts';
import type { SessionToolCall } from '../../session/storage.ts';
import type { Session } from '../../session/types.ts';

export type SubagentKind = 'explore' | 'general';

/**
 * 탐색 에이전트가 쓸 수 있는 도구. 읽기·검색·git 조회·웹만이라 승인 없이 돌고,
 * 잘못 짜인 prompt로도 프로젝트를 건드리지 못한다
 */
export const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
  'get_file_info',
  'list_files',
  'parse_document',
  'read_file',
  'run_git',
  'search_files',
  'web_fetch',
  'web_search',
]);

/** 어느 종류의 자식도 부를 수 없는 도구. 재귀로 에이전트가 에이전트를 낳지 않게 한다 */
const NEVER_FOR_CHILD: ReadonlySet<string> = new Set(['spawn_agent']);

/** 서브에이전트 중첩 깊이 상한. 자식이 다시 자식을 띄우지 못한다 */
const MAX_DEPTH = 1;

/**
 * 동시에 도는 자식 수. 모델이 한 라운드에 열 개를 불러도 프로바이더 분당 한도를
 * 한꺼번에 때리지 않게 나머지는 줄을 선다
 */
const MAX_CONCURRENT = 4;

let running = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (running >= MAX_CONCURRENT) {
    await new Promise<void>(resolve => waiting.push(resolve));
  }
  running += 1;
}

function releaseSlot(): void {
  running -= 1;
  waiting.shift()?.();
}

/**
 * 부모의 승인 창은 한 번에 하나만 뜬다. 형제 자식 둘이 동시에 물으면 뒤의 것이
 * 앞의 것을 덮으므로, 승인 요청을 한 줄로 세운다. 부모 자신의 승인과의 충돌은
 * 컨트롤러 쪽 줄이 막는다
 */
let approvalQueue: Promise<unknown> = Promise.resolve();

function serializedConfirm(
  confirm: (request: ToolRequest) => Promise<boolean>,
): (request: ToolRequest) => Promise<boolean> {
  return request => {
    const next = approvalQueue.then(() => confirm(request));
    approvalQueue = next.catch(() => false);
    return next;
  };
}

export function childToolFilter(kind: SubagentKind): (name: string) => boolean {
  return name =>
    kind === 'explore' ? EXPLORE_TOOLS.has(name) : !NEVER_FOR_CHILD.has(name);
}

/** 자식 루프의 toolTurns에서 도구 호출만 순서대로 편다 */
function collectToolCalls(turns: { toolCalls?: SessionToolCall[] }[]): SessionToolCall[] {
  return turns.flatMap(turn => turn.toolCalls ?? []);
}

export async function runSubagent(
  parentSession: Session,
  parent: AgentLoopContext,
  input: { callId: string; kind: SubagentKind; task: string },
): Promise<{ children: SessionToolCall[]; text: string }> {
  const depth = (parent.depth ?? 0) + 1;
  if (depth > MAX_DEPTH) {
    throw new Error('보조 에이전트는 다시 보조 에이전트를 띄울 수 없습니다. 직접 처리하세요.');
  }

  const child: Session = {
    ...parentSession,
    // 부모의 접힌 자리는 부모 이력 기준이라 자식에는 맞지 않는다
    compaction: undefined,
    initialRows: [],
    messages: [{ at: new Date().toISOString(), content: input.task, role: 'user' }],
    // 자식은 언제나 코딩 도구 기준 — 채팅 탭에는 이 도구가 없어 여기 올 수 없다
    mode: 'agent',
    systemPrompt: undefined,
  };

  const allowTool = childToolFilter(input.kind);
  await acquireSlot();
  try {
    const result = await runAgentLoop(child, {
      allowTool,
      // 자식의 중간 글과 추론은 화면에 흘리지 않는다. 최종 보고가 곧 이 도구의
      // 결과라 그 자리에 보이고, 중간 도구 호출은 이벤트로 중첩돼 나간다
      output: { write() {}, writeReasoning() {} },
      ...(parent.confirmToolUse ? { confirmToolUse: serializedConfirm(parent.confirmToolUse) } : {}),
      depth,
      // 환경 정보는 부모와 같은 값을 같은 자리(대화 맨 끝)에 붙인다
      ...(parent.envContext ? { envContext: parent.envContext } : {}),
      onRetry: parent.onRetry,
      onToolEvent: event => parent.onToolEvent?.({ ...event, parentId: input.callId }),
      signal: parent.signal,
      systemPrompt: await buildSubagentSystemPrompt(parentSession, input.kind, allowTool),
    });
    const children = collectToolCalls(result.toolTurns);
    if (parent.signal?.aborted) {
      return { children, text: '(사용자가 중단해 보조 에이전트가 멈췄습니다.)' };
    }
    // 답 없이 멈춘 자식은 왜 멈췄는지를 보고로 돌려준다. 부모가 그 이유를 보고
    // 다른 방법을 고르거나 사용자에게 넘길 수 있다
    if (result.stop.cause !== 'done') {
      return { children, text: `(보조 에이전트가 멈췄습니다: ${stopSummary(result.stop)})` };
    }
    return {
      children,
      text: result.text.trim() || '(보조 에이전트가 보고 없이 끝났습니다. 필요하면 더 구체적인 prompt로 다시 띄우세요.)',
    };
  } finally {
    releaseSlot();
  }
}

/** 백그라운드로 띄운 직후 모델에게 돌려주는 결과 */
function startedMessage(description: string): string {
  return [
    `보조 에이전트 "${description}"을(를) 백그라운드로 시작했습니다. 보고는 끝나는 대로 [자동 알림] 메시지로 도착합니다.`,
    '그동안 이 보고에 의존하지 않는 일을 계속하세요. 남은 일이 보고를 기다리는 것뿐이면 기다린다고',
    '한 줄만 쓰고 응답을 끝내세요 — 보고가 오면 이어서 진행합니다. 보고 내용을 미리 지어내지 마세요.',
  ].join(' ');
}

registerTool({
  name: 'spawn_agent',
  kind: 'read',
  description: [
    '보조 에이전트를 띄워 독립된 조사나 작업을 맡깁니다. 자식은 백그라운드로 돌고 이 도구는 바로 돌아오며,',
    '보고는 끝나는 대로 [자동 알림] 메시지로 도착합니다.',
    '여러 파일·폴더를 훑어야 하는 탐색(코드베이스 구조 파악, 호출 지점 전부 찾기, 후보 여러 개 비교)에 쓰고,',
    '어느 파일인지 이미 아는 한 번의 조회는 직접 read_file을 쓰세요.',
    '에이전트 하나에는 질문 하나만 맡기세요. 항목이 여럿인 조사는 항목마다 따로 띄우고,',
    '서로 독립된 조사는 한 응답에서 여러 번 호출해 동시에 돌리세요.',
    '보조 에이전트는 이 대화를 볼 수 없으니 prompt에 배경·찾을 것·보고 형식을 완결되게 적으세요.',
    'type: explore(기본, 읽기 전용 — 읽기·검색·git 조회·웹만) | general(파일 수정·셸 실행 가능, 부모와 같은 승인 규칙).',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: '이 에이전트가 하는 일 한 줄 (사용자 화면의 제목, 예: "인증 미들웨어 호출 지점 조사")',
      },
      prompt: {
        type: 'string',
        description: '맡길 일의 전체 지시. 배경, 무엇을 찾거나 할지, 어떤 형식으로 보고할지를 자족적으로',
      },
      type: {
        type: 'string',
        description: 'explore(기본, 읽기 전용) 또는 general(수정·실행 가능)',
      },
    },
    required: ['description', 'prompt'],
  },
  async execute({ description, prompt, type }, context) {
    if (!context) {
      throw new Error('spawn_agent는 에이전트 루프 안에서만 쓸 수 있습니다.');
    }
    const task = String(prompt ?? '').trim();
    if (!task) {
      throw new Error('prompt가 비어 있습니다. 보조 에이전트가 할 일을 완결되게 적어 주세요.');
    }
    if (!String(description ?? '').trim()) {
      throw new Error('description이 비어 있습니다. 무엇을 맡기는지 한 줄로 적어 주세요.');
    }
    const kind: SubagentKind = type === 'general' ? 'general' : 'explore';
    const parent = context.agent;
    const input = { callId: context.callId, kind, task };
    // 보고를 받을 곳이 없으면(CLI 단발 실행) 예전처럼 기다렸다 결과를 돌려준다
    if (!parent.onAgentReport) return runSubagent(context.session, parent, input);

    // 자식의 중단은 부모 턴의 중단을 따르되, 부모 턴이 끝난 뒤에도 끊을 수 있게
    // 따로 둔다 — 컨트롤러가 onAgentStart로 받아 세션 단위 중단에 연결한다
    const abort = new AbortController();
    if (parent.signal?.aborted) abort.abort();
    else parent.signal?.addEventListener('abort', () => abort.abort(), { once: true });
    parent.onAgentStart?.({ abort, callId: context.callId });

    const label = String(description).trim();
    void runSubagent(context.session, { ...parent, signal: abort.signal }, input)
      .then(
        result => ({ ok: true, ...result }),
        (error: Error) => ({ children: [], ok: false, text: `오류: ${error.message}` }),
      )
      .then(({ children, ok, text }) => {
        parent.onAgentReport?.({
          aborted: abort.signal.aborted,
          callId: context.callId,
          children,
          description: label,
          ok,
          text,
        });
      });
    return { background: true, text: startedMessage(label) };
  },
});
