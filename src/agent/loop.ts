// ── 중앙 에이전트 루프 ────────────────────────────────────────────────────────
//
// 흐름:
//   1. 레지스트리에서 도구 목록을 꺼내 LLM에 전달
//   2. LLM이 도구 호출을 반환하면 → 실행 → 결과를 메시지에 추가 → 반복
//   3. 도구 호출이 없으면 → 최종 텍스트를 반환
//
// Provider는 이 루프를 전혀 알 필요가 없고,
// 새 도구를 추가할 때도 이 파일을 수정할 필요가 없음.

import {
  DEFAULT_PERMISSION_MODE,
  decideToolPermission,
} from './permissions.ts';
import {
  agentScriptFor,
  agentWrittenFiles,
  classifyCommand,
} from './commandClassifier.ts';
import type { CommandVerdict } from './commandClassifier.ts';
import {
  dispatchTool,
  getAnthropicTools,
  getOpenAITools,
  getToolApprovalDecision,
  getToolKind,
} from '../tools/registry.ts';
import type { ToolInput } from '../tools/registry.ts';
import { runProviderTurn } from '../providers/index.ts';
import { expandToolHistory } from '../providers/toolHistory.ts';
import { ENV_CONTEXT_MARKER } from '../providers/types.ts';
import {
  KEEP_RECENT_TOOL_ROUNDS,
  OUTPUT_RESERVE_TOKENS,
  applyCompactionCheckpoint,
  clipToolResult,
  compactMessages,
  compactThreshold,
  estimateTokens,
  fitHistoryToWindow,
  messageChars,
  shouldCompact,
  toolCallKey,
  toolResultCapChars,
} from './compact.ts';
import type { CompactionCheckpoint } from './compact.ts';
import { countProviderTokens } from '../providers/index.ts';
import { resolveContextWindow } from '../providers/contextWindow.ts';
import { classifyProviderError } from '../providers/errorInfo.ts';
import type { InternalMessage } from '../providers/images.ts';
import type { StreamResult, StreamUsage } from '../providers/streams.ts';
import type { RetryNotice } from '../providers/fetchWithRetry.ts';
import type { SessionAgentReport, SessionModelMessage } from '../session/storage.ts';
import type { Session } from '../session/types.ts';

// 이 import의 부수 효과로 파일 도구들이 레지스트리에 등록됨.
// 나중에 도구를 추가하면 여기에 import 한 줄만 추가하면 됨.
import '../tools/read/readFile.ts';
import '../tools/write/writeFile.ts';
import '../tools/git/git.ts';
import '../tools/worktree/worktree.ts';
import '../tools/search/searchFiles.ts';
import '../tools/web/webFetch.ts';
import '../tools/web/webSearch.ts';
import '../tools/shell/runCommand.ts';
import '../tools/capture/capturePage.ts';
import '../tools/lazyTools/lazyTools.ts';
import '../tools/subagent/subagent.ts';

export type ToolRequest = {
  name: string;
  input: ToolInput;
  /** 승인을 요구하게 만든 사유 (자격증명 파일 접근 등). 없으면 권한 모드 때문 */
  reason?: string | null;
};

export type ToolEvent = ToolRequest & {
  id: string;
  /**
   * 서브에이전트 안에서 일어난 호출이면 그것을 띄운 spawn_agent 호출의 id.
   * 화면은 그 행 아래에 중첩해 보여준다
   */
  parentId?: string;
  phase: 'start' | 'done';
  /**
   * phase가 done이지만 도구가 일을 백그라운드로 넘긴 것 (보조 에이전트). 화면의
   * 행은 실제 보고가 올 때까지 running으로 둔다
   */
  background?: boolean;
  /**
   * 도구가 실패한 것이 아니라 승인 게이트에서 막힌 것.
   *
   * 실패와 구분해야 한다. 사용자 입장에서 "도구가 오류를 냈다"와 "위험해서
   * 막았다"는 다음에 할 일이 다르다 — 전자는 고칠 거리를 찾아야 하고, 후자는
   * 승인할지 말지를 정하면 된다.
   */
  blocked?: boolean;
  /** 막힌 호출의 차단 주체. 화면은 자동 모드가 막은 것에만 "이 명령 허용"을 붙인다 */
  blockedBy?: BlockedBy;
  /** 막힌 호출의 허용 목록(session.approvedCommands) 값. 셸 명령이면 명령 원문 */
  command?: string;
  /** phase가 done일 때 성공 여부 */
  ok?: boolean;
  /** phase가 done일 때 도구 실행 결과 (실패 시 오류 메시지) */
  result?: string;
  /**
   * 도구가 결과와 함께 돌려준 이미지 (data URL).
   *
   * 화면을 찍는 도구가 생겼는데 모델만 보고 사용자는 텍스트만 보는 상태였다.
   * 무엇을 보고 판단했는지 사람도 볼 수 있어야 한다.
   */
  images?: string[];
};

export type AgentLoopContext = {
  output: { write(chunk: string): void; writeReasoning?(chunk: string): void };
  systemPrompt?: string;
  /** 도구 실행 시작·완료 시 호출됨 (UI 진행 표시용) */
  onToolEvent?: (event: ToolEvent) => void;
  /** 프로바이더가 실측 usage를 반환할 때마다 호출됨 (컨텍스트 게이지용) */
  onUsage?: (usage: StreamUsage) => void;
  /**
   * 이 라운드가 실제로 보낸 입력. 컨텍스트 구성별 측정이 여기서 받은 것을
   * 그대로 다시 재기 때문에, 프롬프트를 새로 조립하지 않고도 보낸 것과 같은
   * 값을 잰다 (조립을 되풀이하면 git 스냅샷 등이 달라져 값이 어긋난다)
   */
  onTurnInputs?: (inputs: { messages: InternalMessage[]; systemPrompt: string; tools: unknown[] }) => void;
  /** 한도 초과로 기다렸다 다시 보낼 때 호출됨 (멈춘 것처럼 보이지 않게) */
  onRetry?: (notice: RetryNotice) => void;
  /**
   * 턴이 도는 동안 사용자가 보낸 메시지를 꺼내 간다. 라운드 시작마다 불러서,
   * 있으면 이력에 끼워 넣고 다음 프로바이더 호출부터 모델이 보게 한다.
   * 꺼낸 것은 비워야 한다 (한 번만 전달)
   */
  takeInterjections?: () => Interjection[];
  /** 끼어든 메시지를 모델에게 넘기는 순간 — 화면의 "안읽음"을 읽은 시각으로 바꾸는 용도 */
  onInterjectionRead?: (id: string, readAt: string) => void;
  /** 권한 모드가 승인을 요구하는 도구의 실행 전 확인. 없으면(non-interactive 등) 무조건 거부됨 */
  confirmToolUse?: (request: ToolRequest) => Promise<boolean>;
  /** 사용자가 턴을 중단할 때 끊기는 신호 */
  signal?: AbortSignal;
  /**
   * 매 턴 달라지는 환경 정보(작업 폴더·git 상태·날짜). 시스템 프롬프트에 두면
   * 그 뒤의 이력 전체가 프로바이더 캐시에서 밀려나므로, 보낼 때만 대화 맨 끝에
   * user 메시지로 붙인다. 세션 이력(messages·toolTurns)에는 들어가지 않는다
   */
  envContext?: string;
  /**
   * 이 루프가 쓸 수 있는 도구를 좁힌다 (서브에이전트용). 목록에서 빠질 뿐 아니라
   * 모델이 이름을 지어내 불러도 실행되지 않는다
   */
  allowTool?: (name: string) => boolean;
  /** 서브에이전트 중첩 깊이. 사용자와 직접 대화하는 턴은 0 */
  depth?: number;
  /** 이력을 압축했을 때마다 호출됨 — 조용히 접으면 "왜 앞을 잊었냐"가 된다 */
  onCompact?: (info: CompactNotice) => void;
  /**
   * 라운드가 시작될 때마다 호출됨. interrupt는 이 라운드의 생성이나 도구 실행만
   * 끊는다 (턴은 이어진다). 작업 중에 보낸 메시지를 사용자가 "지금 보내기"로
   * 밀어 넣으면, 지금 라운드가 끝나기를 기다리지 않고 다음 라운드에서 바로 읽힌다
   */
  onRound?: (round: { interrupt(): void }) => void;
  /** interrupt로 라운드가 끊긴 직후. 화면이 쓰던 답변 행을 닫는 용도 */
  onRoundInterrupted?: () => void;
  /**
   * 이력에 한 건이 확정될 때마다 호출됨 (도구 라운드, 끼어든 메시지).
   *
   * 반환값(toolTurns)은 턴이 정상으로 끝나야 호출자에게 닿는다. 사용자가 중지하면
   * 예외로 빠져나가면서 그때까지 끝낸 도구 왕복이 통째로 사라져, 화면에는 남아
   * 있는 대화가 모델의 이력에는 없는 상태가 됐다. 확정 시점에 흘려보내 중단된
   * 턴도 실제로 끝낸 만큼은 남길 수 있게 한다.
   */
  onTurnMessage?: (message: SessionModelMessage) => void;
  /**
   * 백그라운드 보조 에이전트가 떴을 때. 자식은 부모 턴이 끝나도 계속 돌므로,
   * 컨트롤러가 세션 단위 중단(Esc, 세션 삭제)에 연결한다
   */
  onAgentStart?: (agent: { abort: AbortController; callId: string }) => void;
  /**
   * 백그라운드 보조 에이전트가 끝났을 때. 보고를 부모 이력에 넣는 것은 받는 쪽
   * (컨트롤러)의 몫이다 — 부모 턴이 돌고 있으면 끼어든 메시지로, 끝났으면 새
   * 턴으로. 이 훅이 없으면 spawn_agent는 예전처럼 자식을 기다렸다 결과를 돌려준다
   */
  onAgentReport?: (report: AgentReport) => void;
};

/** 백그라운드 보조 에이전트의 보고 */
export type AgentReport = SessionAgentReport & {
  /** 사용자가 중단해 끝난 것. 모델에게 알릴 보고가 아니라 행만 닫는다 */
  aborted: boolean;
  /** spawn_agent 호출의 description — 알림 문구용 */
  description: string;
};

/** 턴 도중 사용자가 보낸 메시지 (또는 앱이 끼워 넣는 자동 알림) */
export type Interjection = {
  /** 자동 알림이면 실려 온 보조 에이전트 보고 */
  agentReport?: SessionAgentReport;
  /** 보낸 시각 (ISO) */
  at: string;
  /** 사용자가 아니라 앱이 넣은 것 (보조 에이전트 보고 알림). 화면 행이 없다 */
  automatic?: boolean;
  id: string;
  images?: string[];
  text: string;
};

/** 이력을 접었다는 알림. 화면의 "압축 완료" 줄이 이 값을 그린다 */
export type CompactNotice = {
  /** 모델이 받는 압축문 전체 (요약과 요청 원문 목록). 화면이 펼쳐 보여 준다 */
  brief: string;
  /** 접기 전후 입력 토큰의 차이 */
  freedTokens: number;
  kept: number;
  removed: number;
  summarized: boolean;
};

/**
 * 턴이 끝난 이유. 턴은 이 목록 안의 이유로만 끝난다.
 *
 * 예전에는 라운드 상한(25회)·반복 호출 상한·분류기 호출 상한이 저마다 루프를
 * 빠져나갔고, 빠져나간 뒤의 처리도 제각각이었다. 라운드 상한은 아무 표시 없이
 * 끝나면서 마지막 라운드의 문장을 최종 답으로 한 번 더 찍었다 — 사용자에게는
 * 모델이 "확인하겠습니다"라고 해 놓고 멈춘 것으로 보였다. 모델이 일하는 동안
 * 하네스가 횟수로 끊지 않고, 끊는다면 이유를 보여 준다.
 *
 * 오류는 여기 없다. 예외로 올라가 컨트롤러의 오류 행이 맡는다
 */
export type TurnStopCause =
  /** 모델이 도구 호출 없이 답을 끝냈다 */
  | 'done'
  /** 사용자가 중단했다 */
  | 'aborted'
  /** 도구 결과가 새로 달라진 것 없이 NO_PROGRESS_STOP_ROUNDS 라운드가 이어졌다 */
  | 'no_progress'
  /** 이번 턴에 막힌 호출이 MAX_DENIALS_PER_TURN개 쌓였다 */
  | 'denied'
  /** 자동 모드 분류기가 MAX_CLASSIFIER_FAILURES번 연속 판정하지 못했다 */
  | 'classifier_down'
  /** 접고 줄여도 요청이 창에 들어가지 않는다 */
  | 'context';

/** 막힌 호출 하나. 화면이 "허용하고 이어서"로 이 명령을 허용할 수 있다 */
export type BlockedCall = {
  /** 허용 목록(session.approvedCommands)에 넣을 값. 셸 명령이면 명령 원문 */
  command: string;
  name: string;
  reason: string;
};

export type TurnStop = {
  cause: TurnStopCause;
  /** cause가 denied일 때: 이번 턴에 막힌 호출 (같은 명령은 한 번만) */
  blocked?: BlockedCall[];
};

export type AgentLoopResult = {
  /**
   * 이번 턴에 새로 접은 이력. 호출자가 턴 결과를 세션에 넣은 뒤 접힌 자리를
   * 인덱스로 바꿔 session.compaction에 두고 파일에도 남긴다. 없으면 이번 턴에
   * 접지 않았다 (이전에 접힌 자리는 그대로 유효)
   */
  compaction?: CompactionCheckpoint;
  /** 턴이 끝난 이유 */
  stop: TurnStop;
  /**
   * 최종 답변 텍스트. 모델이 답을 끝낸 턴(done)에만 있다 — 다른 이유로 끝난
   * 턴의 마지막 문장은 도구 라운드와 함께 이미 toolTurns에 들어 있다
   */
  text: string;
  /** 최종 답변 라운드의 추론 요약 (있을 때만). 도구 라운드의 것은 toolTurns에 들어 있다 */
  reasoning?: string;
  /** 최종 답변 라운드의 종료 사유 (있을 때만). 'length'면 출력 상한에 잘린 것 */
  stopReason?: string;
  /**
   * 이번 턴의 중간 이력 (프로바이더 중립 포맷) — 도구 라운드와, 그 사이에 끼어든
   * 사용자 메시지가 실제 순서대로. 호출자가 세션에 저장함
   */
  toolTurns: SessionModelMessage[];
};

/**
 * 차단 주체. policy는 자동 모드 분류기, user는 승인 창에서 거부, unattended는 물어볼
 * 사람이 없었음, unverified는 분류기가 판정을 내지 못함 (위험 판정이 아니다)
 */
export type BlockedBy = 'policy' | 'user' | 'unattended' | 'unverified';

/**
 * 화면에 보여줄 차단 사유.
 *
 * 게이트가 붙인 사유를 그대로 앞세운다. "권한이 없습니다" 같은 문구로 뭉개면
 * 사용자가 무엇을 어떻게 할지 판단할 근거가 사라진다.
 */
function blockedReason(reason: string | null, blockedBy: BlockedBy): string {
  const why = reason ?? '권한 모드가 이 종류의 도구에 승인을 요구합니다.';
  if (blockedBy === 'policy') return `자동 모드에서 차단됨 — ${why}`;
  if (blockedBy === 'unattended') return `승인이 필요해 실행하지 않았습니다 — ${why}`;
  if (blockedBy === 'unverified') return `분류기가 판정하지 못해 실행하지 않았습니다 — ${why}`;
  return `승인하지 않아 실행하지 않았습니다 — ${why}`;
}

/**
 * 모델에게 돌려줄 차단 메시지.
 *
 * 차단은 모델이 읽고 스스로 다음 수를 정해야 하는 정보다. 사유만 던지면
 * 같은 명령을 그대로 다시 시도하거나, 반대로 아무 설명 없이 턴을 끝내 버린다.
 * 그래서 네 가지를 함께 준다.
 *
 *   1. 왜 막혔는지
 *   2. 이 작업과 무관한 남은 일은 계속해도 된다
 *   3. 같은 목표를 정상적인 다른 방법으로 시도하는 것은 괜찮다
 *      — 단, 차단의 의도를 우회하는 것은 안 된다
 *   4. 그 작업이 꼭 필요하면 멈추고 사용자에게 설명한다
 *
 * 3번의 단서가 중요하다. 이것이 없으면 모델이 명령을 스크립트 파일에 넣어
 * 실행하거나 문자열을 쪼개서 검사를 피하는 쪽으로 간다 — 셸 판정이 원문
 * 문자열만 본다는 것을 스스로 알아내기 때문이다. 게이트로 막을 수 없는
 * 종류의 우회라 지시로 막는다.
 *
 * 이 문자열은 세션에 저장돼 대화를 다시 열 때 도구 행 상세로도 쓰이므로,
 * 첫 줄을 화면 문구와 같게 맞춘다.
 */
function blockedModelMessage(
  reason: string | null,
  blockedBy: BlockedBy,
  repeated: boolean,
): string {
  const lines = [blockedReason(reason, blockedBy), ''];

  // 판정을 못 받은 것은 위험하다는 뜻이 아니다. 차단처럼 읽으면 모델이 사용자에게
  // 권한을 설명하거나 우회로를 찾아 나서는데, 필요한 건 다른 일을 계속하는 것이다
  if (blockedBy === 'unverified') {
    lines.push(
      '위험하다는 판정이 아닙니다. 분류기가 응답하지 않았거나 응답을 해석하지 못했을 뿐입니다.',
      '같은 명령을 곧바로 다시 시도하지 말고, 이 명령에 의존하지 않는 다른 일을 계속하세요.',
      '이 명령이 꼭 필요하면 무엇을 실행하려 했는지 사용자에게 짧게 알리세요.',
      '사용자는 이 도구 행의 \'이 명령 허용\' 버튼으로 이 명령만 허용할 수 있습니다.',
    );
    return lines.join('\n');
  }

  if (repeated) {
    // 같은 도구가 이번 턴에 또 막혔다. 계속 두드리게 두면 라운드만 태운다
    lines.push(
      '이 작업은 이미 같은 이유로 막혔습니다. 다시 시도하지 마세요.',
      '무엇을 하려 했고 왜 그 권한이 필요한지 사용자에게 설명하고, 진행 방법을 사용자가 정하게 하세요.',
    );
  } else {
    lines.push(
      '이 작업에 의존하지 않는 남은 일이 있으면 그것부터 계속하세요.',
      '같은 목표를 이루는 다른 정상적인 방법은 시도해도 됩니다 (예: 셸 대신 edit_file, 삭제 대신 이름 변경).',
      '다만 차단을 우회하려 들지는 마세요 — 명령을 스크립트 파일에 넣어 실행하거나, 문자열을 쪼개',
      '검사를 피하는 식은 안 됩니다.',
      '이 작업이 요청을 끝내는 데 꼭 필요하다면, 시도를 멈추고 무엇이 왜 필요한지 사용자에게 설명하세요.',
      '그 설명은 막힌 명령과 이유, 사용자가 할 일만 두세 줄로 쓰세요. 이미 보고한 확인 결과를 되풀이하지 마세요.',
    );
  }

  if (blockedBy === 'policy') {
    lines.push(
      '사용자는 이 도구 행의 \'이 명령 허용\' 버튼으로 이 명령만 허용할 수 있고, 권한 모드를 \'권한 요청\'으로',
      '바꿔 승인할 수도 있다는 점을 함께 알려주세요. 허용되면 같은 명령을 글자 하나 바꾸지 말고 다시 실행하세요.',
    );
  }

  return lines.join('\n');
}

export { ENV_CONTEXT_MARKER };

/** 한 턴 안에서 "도구 실패 뒤 손 놓은" 정체를 몇 번까지 강제로 이어붙일지 */
const MAX_STALL_NUDGES = 3;
/** 빈 라운드의 사고 내용을 세션에 남길 때의 상한. 진단용이라 앞부분이면 충분하다 */
const EMPTY_ROUND_REASONING_CHARS = 4_000;

/**
 * 이보다 긴 응답은 "실패 뒤 손 놓은 한마디"가 아니라 실제 답변으로 본다.
 *
 * 선택적인 조회(`git diff --check`)가 거부된 뒤 모델이 그것 없이도 1,700자짜리
 * 최종 답변을 냈는데, 루프가 정체로 오판해 폐기하고 재촉했다. 재촉을 받은 모델은
 * 빈 응답을 내기도 해서, 결국 답변이 통째로 사라진 채 턴이 끝났다. 정체 응답은
 * "못 하겠습니다" 류의 한두 문장이다 — 그보다 긴 것을 버리면 잃는 게 더 크다.
 */
const STALL_MAX_CHARS = 300;

/**
 * 정체 뒤에 모델에게 밀어넣는 재촉 메시지.
 *
 * 직전 라운드의 도구 실패를 후속 조치 없이 넘긴 라운드 뒤에 붙여 다시 돌린다.
 * user 역할로 들어가지만 사용자가 쓴 말이 아니므로, 모델이 이 메시지 자체에
 * 대답해 버리지 않도록 자동 알림 표식을 앞세운다. 실패한 도구 이름을 넣어
 * 무엇을 복구해야 하는지 짚고, 정말 못 하는 경우의 출구도 함께 준다 — 출구는
 * "사용자가 결정할 것"으로 좁혀, 막연한 상황 설명으로 새지 않게 한다.
 */
export function stallNudgeMessage(failedTools: string[]): string {
  const names = failedTools.map(name => `\`${name}\``).join(', ');
  return [
    '[자동 알림 — 사용자가 보낸 메시지가 아닙니다. 이 메시지에 답하거나 이 메시지를 언급하지 마세요.]',
    `직전 라운드에서 ${names} 호출이 실패했는데, 후속 조치 없이 응답이 끝났습니다.`,
    '실패 원인과 복구 방법은 해당 도구 결과에 적혀 있습니다. 그 안내에 따라 이 응답에서',
    '실제 도구 호출로 복구를 이어가 작업을 끝내세요.',
    '도구로 해결할 수 없는 실패라면, 무엇이 왜 막혔고 사용자가 무엇을 결정해 주어야 하는지만',
    '짧게 설명하세요.',
  ].join('\n');
}

/**
 * 인자가 잘린 도구 호출에 대해 모델에게 돌려주는 결과.
 *
 * 긴 파일을 한 번에 도구 인자로 만들다 응답 토큰 한도에 걸려 잘린 경우다. 예전엔
 * 이런 호출을 조용히 버려 모델이 정체에 빠졌다. 이제는 무슨 일이 났고 어떻게
 * 회복하는지를 알려준다 — 파일을 더 작게 나눠서 만들라고.
 */
const TRUNCATED_TOOL_MESSAGE = [
  '이 도구 호출의 인자가 중간에 잘렸습니다 (내용이 한 응답에 담기엔 너무 깁니다).',
  '같은 내용을 한 번에 다시 보내지 마세요 — 또 잘립니다.',
  '더 작게 나누세요: 먼저 짧은 뼈대만 create_file로 만들고, 나머지는 edit_file로',
  '여러 번에 걸쳐 이어붙이세요.',
].join(' ');

/**
 * 같은 호출이 직전과 똑같은 결과를 냈을 때 원문 대신 돌려주는 한 줄.
 *
 * 결과를 못 알아들은 모델은 같은 호출을 되풀이한다. 도구는 매번 같은 답을 주니
 * 원문을 그대로 쌓으면 이력만 불어나 창이 찬다. 원문은 바로 위에 있으므로 같다는
 * 사실만 알리고 다른 수를 찾게 한다. 결과가 달라졌으면(뜨는 중인 서버를 다시 본
 * read_process, 고친 뒤 다시 돌린 테스트) 원문을 그대로 돌려준다
 */
function unchangedResultNote(result: string): string {
  return [
    `직전의 같은 호출과 결과가 똑같습니다 (변화 없음, ${result.length}자). 원문은 위에 그대로 있습니다.`,
    '같은 호출을 되풀이하지 말고 그 결과를 쓰거나 다른 방법을 택하세요.',
  ].join(' ');
}

/** 도구 결과가 새로 달라진 것 없이 이만큼 이어지면 방법을 바꾸라고 재촉한다 */
const NO_PROGRESS_NUDGE_ROUNDS = 3;

/**
 * 이만큼 이어지면 턴을 멈추고 이유를 보여 준다.
 *
 * 일하는 모델은 여기 걸리지 않는다. 한 라운드에 새로 달라진 결과가 하나라도 있으면
 * 셈이 처음부터 다시 시작된다. 라운드 상한 25회에 세 번 끊긴 83라운드짜리 실제
 * 세션을 이 기준으로 다시 세면 결과가 같은 호출이 한 건도 없었다. 걸리는 것은 같은
 * 확인을 되풀이하며 아무것도 얻지 못하는 경우뿐이다
 */
const NO_PROGRESS_STOP_ROUNDS = 5;

/**
 * 한 턴에 막힌 호출이 이만큼 쌓이면 멈추고 사용자에게 넘긴다.
 *
 * 막힌 일을 명령만 바꿔 가며 계속 시도하면 그중 하나가 판정을 빠져나갈 수 있다.
 * 정상적인 작업은 막힐 일이 드물고, 막힌 명령이 쌓였다면 사용자가 볼 때다. 화면은
 * 막힌 명령 목록과 "허용하고 이어서"를 함께 띄운다
 */
const MAX_DENIALS_PER_TURN = 5;

/**
 * 분류기가 연속으로 판정을 내지 못하면 턴을 멈춘다.
 * 판정 실패는 하나하나 실행하지 않고 넘기지만, 이만큼 이어지면 분류기를 쓸 수 없는 상태다.
 * 일시 장애 몇 번으로는 멈추지 않고, 계속 안 되면 막힌 호출만 쌓이기 전에 사용자에게 넘긴다
 */
const MAX_CLASSIFIER_FAILURES = 10;

/**
 * 창을 넘겨 거절된 뒤 다시 보낼 때의 목표 (접는 선에 대한 비율). 실측이 한 번 빗나간
 * 뒤라 접는 선보다 낮게 잡는다
 */
const SALVAGE_TARGET_RATIO = 0.8;

/** 진척 없는 라운드가 이어졌을 때 밀어넣는 재촉 */
export function noProgressNudgeMessage(): string {
  return [
    '[자동 알림 — 사용자가 보낸 메시지가 아닙니다. 이 메시지에 답하거나 이 메시지를 언급하지 마세요.]',
    `최근 ${NO_PROGRESS_NUDGE_ROUNDS}라운드 동안 도구 결과가 새로 달라진 것이 없습니다.`,
    '같은 확인을 되풀이하지 말고 다른 방법을 쓰거나, 지금까지 확인한 것으로 답하세요.',
    '무언가가 준비되기를 기다리는 중이면 start_process로 띄우고 read_process로 출력을 확인하세요.',
  ].join('\n');
}

/** "지금 보내기"가 라운드를 끊을 때의 중단 사유 */
const INTERRUPT_REASON = '사용자가 보낸 메시지를 먼저 읽으려고 이 라운드를 멈췄습니다.';

/** "지금 보내기"로 끊긴 라운드에서 실행하지 않은 도구 호출의 결과 */
const INTERRUPTED_BEFORE_RUN = `실행하지 않았습니다 — ${INTERRUPT_REASON} 그 메시지를 보고 다시 판단하세요.`;

/**
 * 턴이 답 없이 끝난 이유를 한 줄로. 화면의 멈춤 안내, 보조 에이전트의 보고, CLI
 * 출력이 같은 문장을 쓴다
 */
export function stopSummary(stop: TurnStop): string {
  switch (stop.cause) {
    case 'done':
      return '';
    case 'aborted':
      return '사용자가 중단했습니다.';
    case 'no_progress':
      return `도구 결과가 ${NO_PROGRESS_STOP_ROUNDS}라운드 연속 달라지지 않아 멈췄습니다.`;
    case 'denied':
      return `이번 턴에 막힌 호출이 ${MAX_DENIALS_PER_TURN}개 쌓여 멈췄습니다.`;
    case 'classifier_down':
      return `자동 모드 분류기가 ${MAX_CLASSIFIER_FAILURES}번 연속 판정하지 못해 멈췄습니다.`;
    case 'context':
      return '이력을 접고 줄여도 컨텍스트 창에 들어가지 않아 멈췄습니다.';
    default: {
      const unknown: never = stop.cause;
      return String(unknown);
    }
  }
}

/**
 * 분류기에 넘길 최근 주고받음 — 사용자의 최신 메시지와, 그 직전에 어시스턴트가
 * 한 말(무엇을 제안했는지).
 *
 * 정체 재촉([자동 알림 ...])과 앱이 넣은 메시지(automatic: 압축 요약, 보조 에이전트
 * 보고)는 user 역할이지만 사용자가 쓴 말이 아니므로 건너뛴다 — 분류기는 "사용자가
 * 무엇을 시켰는가"를 근거로 판정해야 하고, 모델이 도구 결과를 보고 쓴 글이 그 자리에
 * 들어가면 도구 결과를 분류기에 넣지 않는다는 원칙이 깨진다.
 * 이력이 접혀 첫 요청이 요약 안에 들어가 있으면 foldedFirstPrompt(요청 원문 목록의
 * 첫 항목)를 첫 요청으로 쓴다.
 * 어시스턴트 쪽은 도구만 부르고 글이 없는 라운드를 건너뛰고 실제 글이 있는
 * 것을 잡는다. 사용자가 "ㅇㅋ"라고 답한 대상이 그 글이다.
 */
function latestExchange(
  messages: { automatic?: boolean; content?: unknown; role?: string }[],
  foldedFirstPrompt?: string,
): {
  assistant: string;
  /** 이 대화의 첫 사용자 요청 — 작업이 무엇인지 */
  original: string;
  user: string;
} {
  const isRealUser = (message: { automatic?: boolean; content?: unknown; role?: string }) =>
    message.role === 'user' &&
    !message.automatic &&
    !String(message.content ?? '').startsWith('[자동 알림');

  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUser(messages[i])) {
      userIndex = i;
      break;
    }
  }
  if (userIndex === -1) return { assistant: '', original: foldedFirstPrompt ?? '', user: '' };

  let assistant = '';
  for (let i = userIndex - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue;
    const text = String(messages[i].content ?? '').trim();
    if (text) {
      assistant = text;
      break;
    }
  }
  const first = messages.find(isRealUser);
  return {
    assistant,
    original: foldedFirstPrompt ?? String(first?.content ?? ''),
    user: String(messages[userIndex].content ?? ''),
  };
}

/** 응답이 사용자에게 결정을 되묻는 것으로 끝나는가 (되물음은 정체가 아니다) */
function asksUserToDecide(text: string): boolean {
  const tail = String(text ?? '').trim().slice(-40);
  // "확인해 주세요"류는 문법만 되물음이지 실제로는 검증을 사용자에게 떠넘기는
  // 것이다 (punterVerificationToUser 참고). 정당한 되물음으로 쳐 주면 아래
  // announced 판정의 !asksUserToDecide 조건에 막혀 재촉이 나가지 않는다
  if (punterVerificationToUser(text)) return false;
  return /([?？]|까요|주세요|하시겠어요|드릴까요)[.!?]*\s*$/.test(tail);
}

/**
 * 응답이 화면·페이지 확인을 사용자에게 떠넘기며 끝나는가.
 *
 * 시스템 프롬프트는 UI를 고치면 capture_page로 직접 보고 나서 보고하라고,
 * 확인해 달라고 사용자에게 묻지 말라고 못박아 둔다. 그런데도 "접속해서
 * 확인해 주세요"로 턴을 끝내는 모델이 있다 — 문장은 "-아/어 주세요"라 정당한
 * 되물음(파일명을 알려 주세요 등)과 같은 모양이지만, 여기서는 모델이 자기
 * 도구로 할 수 있는 검증을 사용자에게 미루는 것이다.
 */
export function punterVerificationToUser(text: string): boolean {
  const tail = String(text ?? '').trim().slice(-60);
  return /((접속|방문|열어|들어가)[^.\n]{0,20}확인|화면[^.\n]{0,10}확인|확인\s*(해\s*(주세요|주시겠어요|주실래요|봐\s*주세요)|부탁(드립니다|드려요|해요)?))[.!?]*\s*$/.test(
    tail,
  );
}

/**
 * 응답이 "이제 ~를 확인합니다"처럼 행동을 예고하며 끝나는가.
 *
 * 도구를 여러 번 부른 뒤 "패치 전 마지막 확인: ~를 확인합니다."만 남기고 도구 호출
 * 없이 턴을 끝내는 모델이 있다. 도구 실패가 없으니 정체 재촉에는 걸리지 않고,
 * 사용자는 일하다 말고 혼자 끝난 화면을 본다.
 *
 * 어미만 보는 판정은 오판(짧은 최종 답을 약속으로 봄) 때문에 걷어냈다.
 * 그래서 행동 어간이 붙은 미래·현재 종결만 보고, 호출하는 쪽은 이미 도구를 쓴
 * 턴으로 한정한다. 과거형(했습니다·됐습니다)은 보고이므로 어미가 다르다
 */
export function announcesNextStep(text: string): boolean {
  const tail = String(text ?? '').trim().slice(-60);
  return (
    /(확인|검색|조회|생성|만들|작성|추가|수정|고치|넣|실행|진행|호출|적용|교체|연결|구현|시작|이어|점검|검증|테스트)[가-힣A-Za-z0-9 "'`.]{0,14}(합니다|하겠습니다|하겠어요|할게요|겠습니다|하죠)[.!)\]]*\s*$/.test(
      tail,
    ) || /\b(I'?ll|Let me|I will|Now I)\b[^.\n]{0,80}[.!]?\s*$/i.test(tail)
  );
}

/**
 * 예고만 하고 끝난 라운드 뒤에 밀어넣는 재촉. 정체 재촉과 같은 자동 알림 표식을
 * 쓰고, 이미 끝난 경우의 출구(결과 정리)와 사용자 결정이 필요한 경우의 출구를 준다
 */
export function announcedNudgeMessage(): string {
  return [
    '[자동 알림 — 사용자가 보낸 메시지가 아닙니다. 이 메시지에 답하거나 이 메시지를 언급하지 마세요.]',
    '응답이 다음 작업을 예고하거나, 화면 확인 같은 검증을 사용자에게 떠넘기며 끝났는데 도구',
    '호출이 없었습니다. capture_page 등 가진 도구로 이 응답에서 직접 확인하거나 예고한 작업을',
    '실제 도구 호출로 수행해 끝내세요. 사용자에게 화면을 봐 달라고 하지 마세요 — 그건 당신의',
    '일입니다. 작업이 이미 끝났다면 결과를 정리해 최종 답을 쓰고, 사용자 결정이 필요하면',
    '무엇을 정해야 하는지만 짧게 물으세요.',
  ].join('\n');
}

export async function runAgentLoop(
  session: Session,
  context: AgentLoopContext,
): Promise<AgentLoopResult> {
  // 이력은 프로바이더 중립 포맷으로 유지하고, 호출 직전에만 API 포맷으로 확장함.
  // 세션에 접은 자리가 남아 있으면 그 뒤부터 시작한다 — 접힌 앞부분은 모델 호출
  // 없이 재구성된다 (compact.ts). 접힌 수가 이력보다 크면 맞지 않는 값이라 무시
  const stored = session.compaction;
  const usable = stored && stored.foldedCount <= session.messages.length ? stored : undefined;
  const messages = usable
    ? applyCompactionCheckpoint(
        session.messages,
        usable,
        resolveContextWindow(session.provider, session.model),
      )
    : [...session.messages];
  // 지금 이력의 머리가 어떤 요약·요청 목록으로 접혀 있는지. 다시 접을 때 이어받는다
  let folded: { prompts: string[]; summary: string } | undefined = usable;
  // 이번 턴에 새로 접은 결과 (호출자가 세션에 기록)
  let newFold: CompactionCheckpoint | undefined;
  const toolTurns: SessionModelMessage[] = [];

  // 환경 정보는 보내는 사본의 맨 끝에만 붙인다. 시스템 프롬프트에 두면 매 턴
  // 바뀌는 git 상태 때문에 그 뒤의 이력 전체가 캐시에서 밀려나 처음부터 프리필됐다
  // — 수십만 토큰 세션에서 턴당 분 단위. 세션 이력에는 넣지 않는다.
  // 맨 끝에 두면 접두사 자동 캐시(OpenAI, vLLM 등)는 이력을 그대로 재사용한다.
  // Anthropic은 캐시 표시를 이 메시지 바로 앞에 단다 (anthropic.ts withHistoryCache)
  const toProvider = (history: SessionModelMessage[]) => {
    const expanded = expandToolHistory(history, session.provider);
    if (!context.envContext) return expanded;
    return [...expanded, { role: 'user' as const, content: `${ENV_CONTEXT_MARKER}\n${context.envContext}` }];
  };

  // 토크나이저가 제공자마다 달라 이력의 토큰 수를 직접 셀 수 없다. 한 라운드를
  // 보내고 나면 "보낸 글자 수"와 usage가 알려준 "입력 토큰"이 손에 들어오므로,
  // 그 비율로 다음 라운드의 어림값을 보정한다 (compact.ts의 estimateTokens)
  let charsPerToken = 0;
  /*
   * 창이 차면 그때마다 접는다. 예전에는 한 턴에 한 번만 접었고, 진행 중인 턴은
   * 통째로 원문으로 남겼다. 턴 하나가 길어지면 접을 것이 없어 도구 결과 축약만으로
   * 버티다 400으로 끝났다. 이제는 최근 KEEP_RECENT_TOOL_ROUNDS 라운드만 원문으로
   * 두고 지난 턴과 진행 중인 턴의 오래된 라운드를 한 번에 접는다. 접는 시점은
   * 요약 요청이 들어갈 자리만 남긴 때라(compactThreshold) 한 번에 대부분을 비운다.
   *
   * 접고도 임계 아래로 내려가지 않았으면 이번 턴에는 다시 접지 않는다. 시스템
   * 프롬프트와 도구 정의만으로 창이 거의 차는 작은 창에서는 더 접어도 줄지 않는데,
   * 라운드마다 요약 호출만 붙는다 (창 조회에 실패해 기본값 8,000으로 돈 실측에서
   * 세 라운드마다 접으며 414토큰씩 비웠다). 그 뒤는 도구 결과 축약이 맡는다
   */
  let compactionExhausted = false;

  /*
   * 호출(도구명 + 인자)마다 모델이 마지막으로 받은 결과. 같은 호출이 똑같은 결과를
   * 내면 원문 대신 "변화 없음" 한 줄을 돌려준다.
   *
   * 예전에는 같은 인자로 다시 부르면 아예 실행하지 않았고, 세 번 쌓이면 턴을 끝냈다.
   * 그런데 read_process처럼 부를 때마다 결과가 달라지는 도구도 똑같이 막혀, 서버가
   * 떴는지 다시 보려던 모델이 몇 초 전 결과만 들고 다른 명령으로 돌아가며 라운드를
   * 썼다. 실행은 늘 하고, 결과가 같을 때만 줄인다. 이력이 불어나지 않게 하려던
   * 원래 목적은 그대로 지킨다
   */
  const lastResults = new Map<string, string>();
  // 도구 결과가 새로 달라진 것 없이 이어진 라운드 수
  let unchangedRounds = 0;
  let finalText = '';
  let finalReasoning: string | undefined;
  let finalStopReason: string | undefined;
  let stop: TurnStop = { cause: 'done' };

  // 이번 턴에 차단된 (도구 + 사유) 조합. 두 번째부터는 "그만 시도하고 설명하라"로
  // 문구를 바꾼다. 막힌 이유가 바뀌지 않는데 계속 두드리면 라운드만 태운다
  const blockedKeys = new Set<string>();
  // 이번 턴에 판정으로 막힌 호출. 분류기가 판정하지 못한 것은 넣지 않는다
  const denied: BlockedCall[] = [];

  /*
   * 분류기 판정 캐시 (턴 단위). 같은 명령은 다시 묻지 않는다.
   *
   * 예전에는 턴당 호출 상한(40)을 넘으면 판정 없이 막았다. 긴 턴에서는 서로 다른
   * 명령만으로 상한을 넘겨 안전한 명령까지 막혔다. 비용은 같은 명령 캐시와, 막히는
   * 라운드가 이어지면 멈추는 아래 판정들이 맡는다
   */
  const classifierVerdicts = new Map<string, CommandVerdict>();
  // 분류기가 연속으로 판정을 내지 못한 횟수
  let classifierFailures = 0;

  // 이번 턴에 "실패 뒤 손 놓은" 정체를 몇 번 강제로 이어붙였는지
  let stallNudges = 0;
  // 정체로 폐기한 라운드 중 마지막으로 내용이 있던 것. 재촉 끝에 빈 응답으로
  // 끝나면 이것을 살린다 — 아무 말 없이 끝나는 것보다 버린 답이라도 낫다
  let lastDiscarded: { reasoning?: string; text: string } | null = null;
  // 직전 라운드에서 실제 실행됐다가 실패한 도구 이름들 (실패 뒤 손 놓는 패턴 감지용)
  let prevFailedTools: string[] = [];

  // 마지막 라운드에 보낸 도구 정의. 마무리 호출도 같은 정의를 보내야 요청 앞부분이
  // 본 요청과 같아 캐시를 다시 쓰고, 이력의 도구 호출 블록에 짝이 되는 정의가 있다
  let roundTools: unknown[] = [];

  // 모델이 답을 끝내거나, 사용자가 멈추거나, 아래의 멈춤 판정에 걸릴 때까지 돈다.
  // 라운드 수로는 끊지 않는다
  for (;;) {
    // 도구 실행이 끝난 직후에도 중단 여부를 확인해 다음 라운드로 넘어가지 않게 함
    if (context.signal?.aborted) {
      stop = { cause: 'aborted' };
      break;
    }

    // 이 라운드만 끊는 신호. "지금 보내기"가 진행 중인 생성이나 도구 실행을 끊으면
    // 다음 라운드가 그 메시지를 바로 읽는다. 사용자의 중단(context.signal)도 따른다
    const roundAbort = new AbortController();
    const roundSignal = context.signal
      ? AbortSignal.any([context.signal, roundAbort.signal])
      : roundAbort.signal;
    const interrupted = () => roundAbort.signal.aborted && !context.signal?.aborted;
    context.onRound?.({
      interrupt: () => roundAbort.abort(new DOMException(INTERRUPT_REASON, 'AbortError')),
    });

    // 지난 라운드가 도는 동안 사용자가 보낸 메시지를 이력에 끼운다. 이번 호출부터
    // 모델이 본다. 사용자가 말을 걸었으면 정체 재촉은 무의미하다 — 모델의 다음
    // 응답은 그 말에 대한 답일 수 있다
    const arrived = context.takeInterjections?.() ?? [];
    for (const item of arrived) {
      const readAt = new Date().toISOString();
      // 자동 알림(보조 에이전트 보고)은 사용자가 끼어든 것이 아니다 — 끼어듦
      // 표식 대신 automatic으로 남겨 압축과 화면이 사용자 메시지로 다루지 않게 한다
      const message: SessionModelMessage = {
        ...(item.agentReport ? { agentReport: item.agentReport } : {}),
        at: item.at,
        ...(item.automatic ? { automatic: true } : {}),
        content: item.text,
        ...(item.images?.length ? { images: item.images } : {}),
        ...(item.automatic ? {} : { interjected: true }),
        readAt,
        role: 'user',
      };
      messages.push(message);
      toolTurns.push(message);
      context.onTurnMessage?.(message);
      if (!item.automatic) context.onInterjectionRead?.(item.id, readAt);
    }
    if (arrived.length) {
      prevFailedTools = [];
      // 새 말이 들어왔으니 같은 결과가 이어진 셈도 처음부터 다시 센다
      unchangedRounds = 0;
    }

    // 도구 목록은 이 세션의 모드로 고른다. 전역 toolMode는 화면의 탭을 따라가므로,
    // 화면이 채팅 탭으로 가 있는 동안 백그라운드로 도는 코딩 턴이 도구를 잃으면 안 된다
    const toolMode = session.mode === 'chat' ? 'chat' : 'coding';
    const tools =
      session.provider === 'anthropic'
        ? getAnthropicTools(toolMode, context.allowTool)
        : getOpenAITools(toolMode, context.allowTool);
    roundTools = tools;

    // 이 라운드의 텍스트가 정체 판정으로 폐기될 수 있는가. 화면에 나간 토큰은
    // 어떤 경우에도 지우거나 고치지 않아야 하므로, 폐기 가능성이 있는 라운드만
    // 버퍼에 모았다가 라운드가 확정된 뒤 내보낸다. 가능성이 없으면(대부분의
    // 라운드) 지금처럼 실시간 스트리밍이라 TTFT 손해가 없다.
    // 재촉은 코딩(agent) 모드 전용 — 채팅에서는 도구 실패 후 말로 마무리하는
    // 것이 정당한 경우가 많다.
    const mayDiscard =
      session.mode === 'agent' &&
      prevFailedTools.length > 0 &&
      stallNudges < MAX_STALL_NUDGES;
    // 본문과 추론 요약을 한 버퍼에 순서대로 모은다. 요약은 본문보다 먼저 오므로
    // 따로 모으면 내보낼 때 순서가 바뀌고, 폐기되는 라운드의 요약만 화면에
    // 남는 일도 생긴다 — 요약도 그 라운드의 일부라 같이 버린다
    const buffered: { chunk: string; kind: 'reasoning' | 'text' }[] = [];
    // 이 라운드가 화면에 쓴 글. "지금 보내기"로 끊기면 이력에 남긴다
    let streamedText = '';
    let streamedReasoning = '';
    const turnOutput = mayDiscard
      ? {
          write: (chunk: string) => void buffered.push({ chunk, kind: 'text' }),
          writeReasoning: (chunk: string) => void buffered.push({ chunk, kind: 'reasoning' }),
        }
      : {
          write: (chunk: string) => {
            streamedText += chunk;
            context.output.write(chunk);
          },
          writeReasoning: (chunk: string) => {
            streamedReasoning += chunk;
            context.output.writeReasoning?.(chunk);
          },
        };
    const flushRound = () => {
      for (const { chunk, kind } of buffered) {
        if (kind === 'text') context.output.write(chunk);
        else context.output.writeReasoning?.(chunk);
      }
      buffered.length = 0;
    };
    // "지금 보내기"로 끊긴 라운드. 화면에 이미 쓴 글은 이력에도 남긴다 — 화면에는
    // 있는데 이력에 없으면 다시 열었을 때 사라지고, 모델은 자기가 무슨 말을 하다
    // 멈췄는지 모른다. 폐기될 수 있어 화면에 내보내지 않은 글(buffered)은 버린다
    const recordInterruptedRound = () => {
      if (streamedText.trim()) {
        const partial: SessionModelMessage = {
          at: new Date().toISOString(),
          content: streamedText,
          ...(streamedReasoning.trim() ? { reasoning: streamedReasoning.trim() } : {}),
          role: 'assistant',
          stopReason: 'interrupted',
        };
        messages.push(partial);
        toolTurns.push(partial);
        context.onTurnMessage?.(partial);
      }
      buffered.length = 0;
      context.onRoundInterrupted?.();
    };

    // 창이 차기 전에 접는다. 다 차고 나면 400으로 거절당하는데, 그때는 이미
    // 사용자가 보낸 요청이 통째로 버려진 뒤다.
    //
    // 셀 수 있으면 제공자에게 직접 묻는다(vLLM의 /tokenize). 글자 수 어림은
    // 같은 모델에서도 한국어와 코드가 두 배 넘게 벌어져 크게 빗나간다 — 게이지가
    // 14k를 가리키는 동안 서버는 40,961을 세고 있던 적이 있다.
    //
    // 시스템 프롬프트와 도구 정의도 입력에 포함된다. 이력만 세면 매 요청에 실리는
    // 그 고정분을 통째로 빠뜨리게 된다
    const window = resolveContextWindow(session.provider, session.model);
    const systemPrompt = context.systemPrompt ?? '';
    // 도구 정의는 /tokenize에 넣을 수 없어 글자 수로 어림한다. 시스템 프롬프트는
    // 넣을 수 있으므로 셀 수 있는 경로에서는 실측에 포함한다 — 한국어 지침·메모리
    // 회상을 3자에 한 토큰으로 어림하면 절반으로 적게 센다
    const toolsChars = JSON.stringify(tools ?? []).length;
    const measure = async (history: SessionModelMessage[]) => {
      const counted = await countProviderTokens(session, [
        { role: 'system', content: systemPrompt },
        ...toProvider(history),
      ]);
      return counted === null
        ? estimateTokens(history, charsPerToken) +
            Math.ceil((systemPrompt.length + toolsChars) / 3)
        : counted + Math.ceil(toolsChars / 3);
    };
    let inputTokens = await measure(messages);
    if (shouldCompact(inputTokens, window) && !compactionExhausted) {
      const tokensBefore = inputTokens;
      const countBefore = messages.length;
      // 지난 턴과 진행 중인 턴의 오래된 라운드를 한 번에 접는다. 요약 요청은 본 요청과
      // 같은 시스템 프롬프트와 도구로 보내 제공자가 계산해 둔 앞부분을 다시 쓰게 한다
      const result = await compactMessages(session, messages, {
        checkpoint: folded,
        contextWindow: window,
        keepToolRounds: KEEP_RECENT_TOOL_ROUNDS,
        signal: context.signal,
        systemPrompt,
        tools,
      });
      if (result.compacted && result.checkpoint) {
        messages.splice(0, messages.length, ...result.messages);
        folded = result.checkpoint;
        newFold = result.checkpoint;
        // 접고 나면 글자 수가 확 줄어 이전 비율이 맞지 않는다. 다음 라운드의
        // 실측으로 다시 잡게 초기화한다
        charsPerToken = 0;
        // 접힌 결과는 모델이 더는 원문으로 보지 못한다. 같은 호출이 오면 원문을 돌려준다
        lastResults.clear();
        // 접힌 이력을 다시 재야 아래의 축약·출력 예약 판정이 옛 값을 쓰지 않는다
        inputTokens = await measure(messages);
        compactionExhausted = shouldCompact(inputTokens, window);
        context.onCompact?.({
          brief: result.brief ?? '',
          // 접기 전 크기는 창까지만 센다. 상한이 생기기 전에 저장된 결과는 이력에 창의
          // 몇 배로 남아 있어도 모델에게는 줄여서만 갔다 (262K 창에 "812k 절약"이 떴다)
          freedTokens: Math.max(0, Math.min(tokensBefore, window) - inputTokens),
          kept: messages.length,
          removed: Math.max(0, countBefore - messages.length),
          summarized: result.summarized,
        });
      }
    }

    // 접힌 뒤에도, 또는 접기 전이라도 창이 차오르면 보내는 사본에서 오래된 도구
    // 결과를 한 줄로 줄인다. 원문으로 남기는 건 진행 중인 턴 하나뿐인데 그 안에서
    // 파일을 여러 번 읽으면 그것만으로 창을 채운다 — 직전 두 라운드만 원문이면
    // 하던 작업은 이어진다. 그래도 넘치면 직전 두 라운드의 결과도 가운데를 덜어 낸다.
    // 직전 라운드의 결과 하나가 창보다 크면 앞의 것만 줄여서는 들어가지 않는다.
    // 화면과 세션의 원문은 그대로다. 줄인 호출은 "변화 없음" 비교에서 뺀다. 모델이
    // 원문을 다시 보려고 부르면 원문이 가야 한다.
    //
    // folded 자체는 조건에 넣지 않는다. 예전에는 (folded || ...)라서 세션이 살면서
    // 단 한 번이라도 압축된 적이 있으면, 그 뒤로는 창 여유와 무관하게 매 라운드
    // 직전 두 라운드를 뺀 나머지를 전부 잘랐다 — 262K 창에 여유가 넘쳐도 15개
    // 넘는 파일을 훑는 조사에서 3번째 파일부터 내용이 지워지고, 모델이 그 안내를
    // 따라 이미 읽은 파일을 다시 읽길 반복해 끝나지 않는 원인이었다. 매 라운드
    // 실측한 inputTokens만 보면 실제로 창이 찰 때만 잘라 그 문제가 없다
    let historyToSend = messages;
    if (shouldCompact(inputTokens, window)) {
      const stubbed = new Set<string>();
      const fitted = await fitHistoryToWindow(messages, {
        keepRounds: KEEP_RECENT_TOOL_ROUNDS,
        measure,
        stubbed,
        targetTokens: compactThreshold(window),
        tokens: inputTokens,
      });
      historyToSend = fitted.history;
      inputTokens = fitted.tokens;
      for (const key of stubbed) lastResults.delete(key);
    }

    const sentMessages = toProvider(historyToSend);
    const sentChars = messageChars(historyToSend);
    context.onTurnInputs?.({
      messages: sentMessages,
      systemPrompt,
      tools,
    });

    // 출력 예약분은 남은 창 안이어야 한다. vLLM은 입력 + max_tokens가 창을 넘으면
    // 생성 전에 거절하고, 창이 큰 모델에서는 사고가 폭주하면 창을 통째로 먹는다.
    // 남은 창을 모르면(창 조회 실패) 설정값을 그대로 둔다
    const outputLimit = (tokens: number) => {
      const remaining = window - tokens - OUTPUT_RESERVE_TOKENS;
      return remaining > 0 ? Math.min(session.maxTokens, remaining) : session.maxTokens;
    };
    const maxTokens = outputLimit(inputTokens);
    const providerContext = { ...context, output: turnOutput, signal: roundSignal, tools };

    let result: StreamResult | null = null;
    try {
      result = await runProviderTurn(
        { ...session, maxTokens, messages: sentMessages },
        providerContext,
      );
    } catch (error) {
      if (!interrupted()) {
        if (context.signal?.aborted || classifyProviderError(error).kind !== 'context-length') {
          throw error;
        }
        // 예방 판정이 빗나가 창을 넘겼다(도구 정의 어림 오차, 창 조회 실패 등).
        // 직전 라운드의 결과만 남기고 나머지 도구 결과를 줄이고, 그래도 넉넉하지
        // 않으면 직전 라운드의 결과도 가운데를 덜어 내 한 번 다시 보낸다. 그래도
        // 거절되면 멈추고 이유를 보여 준다. 오류로 올리면 이 턴에 끝낸 도구 라운드를
        // 호출자가 이력에 남기지 못한다
        const stubbed = new Set<string>();
        const salvaged = await fitHistoryToWindow(messages, {
          keepRounds: 1,
          measure,
          stubbed,
          targetTokens: Math.floor(compactThreshold(window) * SALVAGE_TARGET_RATIO),
        });
        for (const key of stubbed) lastResults.delete(key);
        try {
          result = await runProviderTurn(
            {
              ...session,
              // 출력 상한도 접는 선이 남겨 두는 자리까지만 준다. 입력 어림이 빗나간 뒤라
              // 줄여서 빈 자리를 출력으로 다 채우면 같은 오차로 다시 넘친다
              maxTokens: Math.min(outputLimit(salvaged.tokens), window - compactThreshold(window)),
              messages: toProvider(salvaged.history),
            },
            providerContext,
          );
        } catch (retryError) {
          if (!interrupted()) {
            if (
              context.signal?.aborted ||
              classifyProviderError(retryError).kind !== 'context-length'
            ) {
              throw retryError;
            }
            stop = { cause: 'context' };
            break;
          }
        }
      }
    }
    // 사용자가 "지금 보내기"로 이 라운드를 끊었다. 다음 라운드가 그 메시지를 읽는다
    if (!result) {
      recordInterruptedRound();
      continue;
    }

    finalText = result.text;
    finalReasoning = result.reasoning;
    finalStopReason = result.stopReason;

    // 마지막 호출의 usage가 현재 컨텍스트 점유량 (프롬프트에 전체 이력이 포함됨)
    if (result.usage) {
      context.onUsage?.(result.usage);
      // 이번에 보낸 글자 수와 실제 입력 토큰으로 이 모델의 비율을 잡는다.
      // 다음 라운드의 압축 판정이 어림이 아니라 실측에 기대게 된다
      if (result.usage.inputTokens > 0 && sentChars > 0) {
        charsPerToken = sentChars / result.usage.inputTokens;
      }
    }

    // 도구 호출이 없으면 보통은 대화 종료. 다만 직전 라운드에서 도구가 실패했는데
    // 후속 조치 없이 끝낸 경우(정체)엔, 실패 결과에 적힌 안내대로 복구를 이어가도록
    // 한 번 더 못박아 돌린다. 폐기되는 텍스트는 버퍼에만 있어 화면에 나간 적이 없다.
    if (result.toolCalls.length === 0) {
      const stalled =
        mayDiscard &&
        result.text.trim().length <= STALL_MAX_CHARS &&
        !asksUserToDecide(result.text) &&
        !context.signal?.aborted;
      if (stalled) {
        stallNudges += 1;
        if (result.text.trim()) lastDiscarded = { reasoning: result.reasoning, text: result.text };
        // 폐기한 텍스트와 재촉은 이 턴 안에서만 쓰는 임시 메시지다. 세션에 저장하면
        // 다음 대화가 "실패하고 손 놓은" 기록으로 오염돼 같은 정체를 부른다.
        messages.push({ role: 'assistant', content: result.text });
        // automatic: 앱이 넣은 말이라 압축이 사용자 턴의 시작이나 요청 원문으로 세지 않게 한다
        messages.push({ automatic: true, role: 'user', content: stallNudgeMessage(prevFailedTools) });
        prevFailedTools = [];
        continue;
      }
      // 실패는 없었지만, 이미 도구를 쓰던 턴이 다음 행동을 예고만 하고 끝냈거나
      // (announcesNextStep) 화면 확인을 사용자에게 떠넘기고 끝난 라운드
      // (punterVerificationToUser). 할 일을 하라고 한 번 더 돌린다. 이 텍스트는
      // 이미 화면에 나갔으므로 폐기하지 않지만, 정체 재촉과 같은 이유로 세션에는
      // 남기지 않는다 — 남기면 다음 대화가 "예고만 하고 안 한" 기록으로 오염돼
      // 같은 정체를 부른다
      const announced =
        session.mode === 'agent' &&
        toolTurns.length > 0 &&
        stallNudges < MAX_STALL_NUDGES &&
        result.text.trim().length <= STALL_MAX_CHARS &&
        (announcesNextStep(result.text) || punterVerificationToUser(result.text)) &&
        !asksUserToDecide(result.text) &&
        !context.signal?.aborted;
      if (announced) {
        stallNudges += 1;
        flushRound();
        messages.push({ role: 'assistant', content: result.text });
        messages.push({ automatic: true, role: 'user', content: announcedNudgeMessage() });
        continue;
      }
      // 본문도 도구 호출도 없이 끝난 라운드는 세션에 남지 않아, 모델이 무엇을
      // 생각하다 멈췄는지 나중에 볼 길이 없었다. 사고 내용과 종료 사유만 남긴다.
      // 모델에게 되보내는 이력(messages)에는 넣지 않는다 — 빈 assistant 메시지는
      // API가 거부하거나 "아무것도 안 한 기록"으로 다음 턴을 오염시킨다
      if (!result.text.trim() && (result.reasoning?.trim() || result.stopReason)) {
        const note: SessionModelMessage = {
          at: new Date().toISOString(),
          content: '',
          ...(result.reasoning?.trim()
            ? { reasoning: result.reasoning.trim().slice(0, EMPTY_ROUND_REASONING_CHARS) }
            : {}),
          role: 'assistant',
          ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        };
        toolTurns.push(note);
        context.onTurnMessage?.(note);
      }
      flushRound();
      stop = { cause: 'done' };
      break;
    }
    flushRound();

    // 권한 모드에 따라 승인이 필요한 도구는 실행 전 사용자 확인을 순차적으로 받음.
    // 막힌 호출도 왜 막혔는지 남겨야 한다 — 사유 없이 사라지면 사용자는 모델이
    // 그냥 마음을 바꾼 것처럼 본다
    const permissionMode = session.permissionMode ?? DEFAULT_PERMISSION_MODE;
    const approvals: {
      approved: boolean;
      reason: string | null;
      blockedBy: BlockedBy | null;
      /** 이번 턴에 같은 도구가 같은 사유로 이미 막혔는가 */
      repeated: boolean;
    }[] = [];

    // 왜 실행하는지(description, 이번 라운드의 말)와 무엇을 실행하는지(에이전트가
    // 이 턴에서 쓴 스크립트면 그 앞부분)를 같이 준다. 명령 문자열만 보고는
    // 에이전트가 방금 만든 패치 스크립트도 "알 수 없는 외부 스크립트"였다
    const exchange = latestExchange(messages, folded?.prompts[0]);
    const writtenFiles = agentWrittenFiles(toolTurns);
    const roundNote = result.text;
    const classify = (command: string, input: ToolInput) =>
      classifyCommand(session, {
        agentScript: agentScriptFor(command, writtenFiles),
        assistantNote: roundNote,
        command,
        description: String(input.description ?? ''),
        originalRequest: exchange.original,
        priorAssistantMessage: exchange.assistant,
        userMessage: exchange.user,
      }, context.signal);
    // 분류기에 물을 호출은 먼저 한꺼번에 보낸다. 한 라운드에 명령이 여럿이면 하나씩
    // 기다리는 만큼 판정 시간이 늘어난다. 판정 결과를 쓰는 순서는 아래에서 그대로다
    const pendingVerdicts = new Map<string, Promise<CommandVerdict>>();
    for (const tc of result.toolCalls) {
      if (tc.truncated) continue;
      const command = callCommand(tc.name, tc.input);
      if (
        pendingVerdicts.has(command) ||
        classifierVerdicts.has(command) ||
        session.approvedCommands?.includes(command)
      ) {
        continue;
      }
      const decision = decideToolPermission(
        permissionMode,
        getToolKind(tc.name),
        getToolApprovalDecision(tc.name, tc.input),
      );
      if (decision === 'classify') pendingVerdicts.set(command, classify(command, tc.input));
    }

    for (const tc of result.toolCalls) {
      // 인자가 잘린 호출은 권한 판정 없이 통과시킨다 — 실제 실행은 안 하고
      // 아래 outcomes에서 "잘렸으니 나눠서 다시 하라"는 결과만 돌려준다
      if (tc.truncated) {
        approvals.push({ approved: true, reason: null, blockedBy: null, repeated: false });
        continue;
      }
      const input = tc.input;
      const command = callCommand(tc.name, input);
      // 사용자가 멈춤 안내의 "허용하고 이어서"로 허용한 명령. 정확히 같은 문자열만
      // 이 세션 동안 판정 없이 실행한다
      if (session.approvedCommands?.includes(command)) {
        approvals.push({ approved: true, reason: null, blockedBy: null, repeated: false });
        continue;
      }
      const approval = getToolApprovalDecision(tc.name, input);
      const reason = approval?.reason ?? null;
      const decision = decideToolPermission(
        permissionMode,
        getToolKind(tc.name),
        approval,
      );

      if (decision === 'allow') {
        approvals.push({ approved: true, reason, blockedBy: null, repeated: false });
        continue;
      }

      // 허용목록 밖 셸 명령: 자동 모드에서는 LLM 분류기가 판정한다.
      // 파괴적·자격증명 명령은 여기 오기 전에 confirm으로 걸러져 있다.
      if (decision === 'classify') {
        let verdict = classifierVerdicts.get(command);
        if (!verdict) {
          verdict = await (pendingVerdicts.get(command) ?? classify(command, input));
          // 판정하지 못한 것은 캐시하지 않는다. 다음에 다시 물으면 판정할 수 있다
          if (!verdict.unavailable) classifierVerdicts.set(command, verdict);
        }
        if (verdict.unavailable) {
          classifierFailures += 1;
          approvals.push({ approved: false, reason: verdict.reason, blockedBy: 'unverified', repeated: false });
          continue;
        }
        classifierFailures = 0;
        if (verdict.allow) {
          approvals.push({ approved: true, reason: null, blockedBy: null, repeated: false });
          continue;
        }
        const classifierReason = `분류기 판정: ${verdict.reason}`;
        const key = `${tc.name} ${classifierReason}`;
        const repeated = blockedKeys.has(key);
        blockedKeys.add(key);
        approvals.push({ approved: false, reason: classifierReason, blockedBy: 'policy', repeated });
        continue;
      }

      // 자동 모드는 묻지 않고 막는다. 자리를 비우려고 켜는 모드라 창을 띄워도
      // 볼 사람이 없고, 턴만 거기서 멈춘다
      const blockedBy: BlockedBy =
        decision === 'deny' ? 'policy' : context.confirmToolUse ? 'user' : 'unattended';

      if (blockedBy === 'user' && context.confirmToolUse) {
        const approved = await context.confirmToolUse({ name: tc.name, input, reason });
        if (approved) {
          approvals.push({ approved: true, reason, blockedBy: null, repeated: false });
          continue;
        }
      }

      const key = `${tc.name} ${reason ?? ''}`;
      const repeated = blockedKeys.has(key);
      blockedKeys.add(key);
      approvals.push({ approved: false, reason, blockedBy, repeated });
    }

    // 판정하는 동안 "지금 보내기"가 들어왔으면 실행하지 않는다. 호출과 결과의 짝은
    // 맞춰 남기고, 모델은 다음 라운드에서 사용자의 메시지부터 본다
    const skipRun = interrupted();

    // 승인된 도구를 병렬 실행. fresh는 이 호출이 모델에게 새로운 결과를 줬는가 —
    // 진척 판정의 근거다 (막힘·잘림·변화 없음은 false, 끊긴 라운드는 셈에서 뺀다)
    const outcomes = await Promise.all(
      result.toolCalls.map((tc, index) => {
        const input = tc.input;
        // 인자가 잘린 호출: 실행하지 않고 "잘렸으니 나눠서 다시 하라"고 돌려준다.
        // 화면·세션에도 실패로 남겨 무슨 일이 났는지 사람도 볼 수 있게 한다.
        if (tc.truncated) {
          context.onToolEvent?.({
            id: tc.id, name: tc.name, input, ok: false, phase: 'done',
            result: TRUNCATED_TOOL_MESSAGE,
          });
          return Promise.resolve({
            children: undefined, fresh: false, images: [] as string[], ok: false,
            result: TRUNCATED_TOOL_MESSAGE,
          });
        }
        const { approved, reason, blockedBy, repeated } = approvals[index];
        if (!approved) {
          // 화면에도 남긴다. 승인 창을 닫고 나면 무엇이 왜 막혔는지 확인할 방법이
          // 없었고, 자동 모드에서는 애초에 창도 뜨지 않아 흔적이 전혀 없었다.
          // 화면과 세션에 같은 문자열을 쓴다 — 실행 중에 본 것과 대화를 다시 열어
          // 본 것이 다르면 같은 차단을 두 번 다르게 읽게 된다
          const message = blockedModelMessage(reason, blockedBy ?? 'policy', repeated);
          context.onToolEvent?.({
            blocked: true,
            blockedBy: blockedBy ?? 'policy',
            command: callCommand(tc.name, input),
            id: tc.id,
            input,
            name: tc.name,
            ok: false,
            phase: 'done',
            reason,
            result: message,
          });
          return Promise.resolve({
            children: undefined, fresh: false, images: [] as string[], ok: false, result: message,
          });
        }
        if (skipRun) {
          context.onToolEvent?.({ id: tc.id, input, name: tc.name, phase: 'start' });
          context.onToolEvent?.({
            id: tc.id, input, name: tc.name, ok: false, phase: 'done',
            result: INTERRUPTED_BEFORE_RUN,
          });
          return Promise.resolve({
            children: undefined, fresh: false, images: [] as string[], ok: false,
            result: INTERRUPTED_BEFORE_RUN,
          });
        }

        // 결과가 직전의 같은 호출과 똑같으면 원문 대신 "변화 없음" 한 줄을 돌려준다.
        // 이미지가 딸린 결과는 글이 같아도 그림이 다를 수 있어 비교하지 않는다.
        // 결과 하나가 창의 큰 몫을 차지하면 앞뒤만 남긴다 (compact.ts의
        // TOOL_RESULT_WINDOW_SHARE). 화면과 세션에도 줄인 결과가 남는다
        const callKey = toolCallKey(tc.name, input);
        const settle = (raw: string, images: string[]) => {
          const text = clipToolResult(raw, toolResultCapChars(window));
          const unchanged = images.length === 0 && lastResults.get(callKey) === text;
          lastResults.set(callKey, text);
          return { fresh: !unchanged, text: unchanged ? unchangedResultNote(text) : text };
        };

        context.onToolEvent?.({ id: tc.id, name: tc.name, input, phase: 'start' });
        // 목록에서 뺀 도구를 이름만 지어내 부른 경우. 실행하지 않고 이유를 돌려준다.
        // 도구는 라운드 신호를 받는다 — "지금 보내기"가 돌고 있는 명령도 끊는다.
        // 보조 에이전트만은 턴 신호를 준다. 자식은 그 신호에 묶여 백그라운드로 도는데,
        // 라운드 신호에 묶으면 끼어든 메시지 하나에 사용자가 띄워 둔 자식까지 끊긴다
        const run =
          context.allowTool && !context.allowTool(tc.name)
            ? Promise.reject(new Error(`이 에이전트는 ${tc.name} 도구를 쓸 수 없습니다.`))
            : dispatchTool(tc.name, input, {
                agent: tc.name === 'spawn_agent' ? context : { ...context, signal: roundSignal },
                callId: tc.id,
                session,
              });
        return run
          .then(outcome => {
            const { fresh, text } = settle(outcome.text, outcome.images);
            context.onToolEvent?.({
              ...(outcome.background ? { background: true } : {}),
              id: tc.id,
              images: outcome.images,
              input,
              name: tc.name,
              ok: true,
              phase: 'done',
              result: text,
            });
            return {
              children: outcome.children,
              fresh,
              images: outcome.images,
              ok: true,
              result: text,
            };
          })
          .catch(err => {
            const { fresh, text } = settle(`오류: ${err.message}`, []);
            context.onToolEvent?.({
              id: tc.id, name: tc.name, input, ok: false, phase: 'done', result: text,
            });
            return { children: undefined, fresh, images: [] as string[], ok: false, result: text };
          });
      }),
    );

    // 이번 라운드(텍스트 + 도구 호출·결과)를 중립 포맷 한 건으로 이력에 추가
    const turn: SessionModelMessage = {
      at: new Date().toISOString(),
      role: 'assistant',
      content: result.text,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      toolCalls: result.toolCalls.map((tc, index) => ({
        // 차단은 감사 흔적이라 세션에 남긴다. 실패로만 남기면 다시 열었을 때
        // "도구가 오류를 냈다"로 복원돼 무엇이 왜 막혔는지가 사라진다
        ...(approvals[index].approved ? {} : { blocked: true }),
        ...(outcomes[index].children?.length ? { children: outcomes[index].children } : {}),
        id: tc.id,
        ...(outcomes[index].images.length ? { images: outcomes[index].images } : {}),
        input: tc.input,
        name: tc.name,
        ok: outcomes[index].ok,
        result: outcomes[index].result,
      })),
    };
    messages.push(turn);
    toolTurns.push(turn);
    // 호출과 결과가 한 건으로 묶인 뒤에만 통보한다 — 중단이 여기 앞에서 끊기면
    // 그 라운드는 통째로 빠지므로 짝이 깨진 도구 호출이 이력에 남지 않는다
    context.onTurnMessage?.(turn);

    // 이번 라운드에서 실제로 실행된(막히지 않은) 도구 중 실패한 것들.
    // 다음 라운드가 도구 없이 끝나면 "실패하고 손 놓음"으로 보고 이어붙인다.
    prevFailedTools = [
      ...new Set(
        result.toolCalls
          .filter((_, index) => approvals[index].approved && !outcomes[index].ok)
          .map(tc => tc.name),
      ),
    ];

    // 판정으로 막힌 호출을 모은다. 분류기가 판정하지 못한 것은 위험 판정이 아니라 빼고,
    // "지금 보내기"가 승인 창을 닫아 막힌 것도 사용자가 거절한 것이 아니라 뺀다
    for (const [index, tc] of result.toolCalls.entries()) {
      const { approved, blockedBy, reason } = approvals[index];
      if (approved || tc.truncated || blockedBy === 'unverified' || interrupted()) continue;
      denied.push({
        command: callCommand(tc.name, tc.input),
        name: tc.name,
        reason: blockedReason(reason, blockedBy ?? 'policy'),
      });
    }

    // 진척 판정. 새로 달라진 결과가 하나라도 있으면 셈을 처음부터 다시 한다.
    // 분류기가 판정하지 못한 호출과 끊긴 라운드는 모델 탓이 아니라 셈에서 뺀다
    if (!interrupted()) {
      const judged = result.toolCalls.filter(
        (_, index) => approvals[index].blockedBy !== 'unverified',
      ).length;
      if (outcomes.some(outcome => outcome.fresh)) unchangedRounds = 0;
      else if (judged > 0) unchangedRounds += 1;
    }

    if (classifierFailures >= MAX_CLASSIFIER_FAILURES) {
      stop = { cause: 'classifier_down' };
      break;
    }
    if (denied.length >= MAX_DENIALS_PER_TURN) {
      stop = { blocked: uniqueBlockedCalls(denied), cause: 'denied' };
      break;
    }
    if (unchangedRounds >= NO_PROGRESS_STOP_ROUNDS) {
      stop = { cause: 'no_progress' };
      break;
    }
    if (unchangedRounds === NO_PROGRESS_NUDGE_ROUNDS) {
      // 이 턴 안에서만 쓰는 임시 메시지다. 세션에 남기면 다음 대화가 오염된다
      messages.push({ automatic: true, role: 'user', content: noProgressNudgeMessage() });
    }
  }

  // 모델이 답을 끝낸 턴이 아니다. 마지막 라운드의 글은 도구 호출과 함께 이미
  // toolTurns에 들어 있어, 최종 답으로 또 넘기면 같은 문장이 도구 호출 없이 한 번
  // 더 찍힌다 — 모델이 "확인하겠습니다"라고 해 놓고 아무것도 안 한 것처럼 보였다
  if (stop.cause !== 'done') {
    return {
      ...(newFold ? { compaction: newFold } : {}),
      stop,
      text: '',
      toolTurns,
    };
  }

  // 재촉 끝에 빈 응답으로 끝났으면 마지막으로 폐기한 답변을 살린다. 재촉을 받은
  // 모델이 아무 말도 안 하는 경우가 실제로 있었고, 그러면 사용자는 빈 턴을 본다
  if (!finalText.trim() && lastDiscarded && !context.signal?.aborted) {
    if (lastDiscarded.reasoning) context.output.writeReasoning?.(lastDiscarded.reasoning);
    context.output.write(lastDiscarded.text);
    finalText = lastDiscarded.text;
    finalReasoning = lastDiscarded.reasoning;
  }

  // 도구를 여러 번 부른 뒤 마지막 라운드를 본문 없이 끝내는 모델이 있다 — 답을
  // 사고 채널에만 쓰고 content를 비운다. 그대로 두면 사용자는 빈 턴을, 보조
  // 에이전트를 띄운 부모는 "보고 없이 끝났습니다"를 본다. 한 번만 마무리를
  // 요구하고, 그래도 비면 사고 채널 글이라도 답으로 남긴다
  if (!finalText.trim() && toolTurns.length > 0 && !context.signal?.aborted) {
    messages.push({
      at: new Date().toISOString(),
      role: 'user',
      content:
        '[자동 알림] 마지막 응답의 본문이 비어 있었습니다. 지금까지 확인한 것으로 답을' +
        ' 작성하세요. 확인하지 못한 부분은 그렇다고 밝히세요. 도구를 더 부르지 마세요.',
    });
    // 도구 정의는 보내되 결과는 본문만 쓴다. 모델이 그래도 도구를 부르면 실행하지 않는다
    const closing = await runProviderTurn(
      { ...session, messages: toProvider(messages) },
      { ...context, output: context.output, tools: roundTools },
    );
    if (closing.text.trim()) {
      finalText = closing.text;
      finalReasoning = closing.reasoning;
      finalStopReason = closing.stopReason;
    } else if ((closing.reasoning ?? finalReasoning ?? '').trim()) {
      finalText = (closing.reasoning ?? finalReasoning ?? '').trim();
      context.output.write(finalText);
    }
  }

  return {
    ...(newFold ? { compaction: newFold } : {}),
    stop,
    text: finalText,
    toolTurns,
    ...(finalReasoning ? { reasoning: finalReasoning } : {}),
    ...(finalStopReason ? { stopReason: finalStopReason } : {}),
  };
}

/**
 * 분류기와 허용 목록이 호출을 가리키는 문자열. 셸 명령이면 명령 원문, 아닌
 * 도구(delete_file 등)는 호출 자체를 명령처럼 적는다
 */
function callCommand(name: string, input: ToolInput): string {
  return typeof input.command === 'string' ? input.command : `${name} ${JSON.stringify(input)}`;
}

/** 같은 명령은 한 번만. 화면이 목록으로 보여 주고 허용할 때 쓴다 */
function uniqueBlockedCalls(calls: BlockedCall[]): BlockedCall[] {
  const seen = new Set<string>();
  return calls.filter(call => {
    if (seen.has(call.command)) return false;
    seen.add(call.command);
    return true;
  });
}
