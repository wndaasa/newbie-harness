// 대화 이력 압축.
//
// 지금까지는 session.messages 전체가 매 턴 그대로 나갔다. 클라우드 모델은 창이
// 20만이라 좀처럼 차지 않았지만, 로컬 모델(vLLM Qwen3-8B는 40,960)에서는 몇 턴
// 만에 한도에 닿는다. 닿으면 400으로 죽고 그걸로 끝이었다 — errorInfo가
// context-length로 분류만 하고 아무 조치도 하지 않았다.
//
// 무엇을 남기는가:
//
//   1. 사용자가 직접 친 프롬프트는 전부 남긴다
//      요약은 "무엇을 했는지"를 남기지만 "무엇을 시켰는지"는 뭉갠다. 사용자가
//      건 제약("띠 넣지 마", "최소 수정만")은 대화 내내 유효한데 요약 한 줄에
//      들어가면 사라진다. 그래서 요약과 별개로 원문을 목록으로 유지한다.
//
//   2. 오래된 구간은 모델이 요약한 한 덩어리로 갈아 끼운다
//
//   3. 최근 몇 턴은 원문 그대로 둔다
//      직전 맥락은 요약으로 대체하면 곧바로 티가 난다.
//
// 도구 호출과 결과는 한 SessionModelMessage 안에 함께 들어 있으므로(toolCalls),
// 메시지를 통째로만 버리면 짝이 깨지지 않는다. 절대 부분적으로 잘라내지 말 것.
//
// 한 번 접은 결과는 세션에 남긴다(session.compaction, 파일의 compact 엔트리). 예전에는
// 압축이 턴 안에서만 살고 다음 턴은 원본 이력 전체에서 다시 시작했는데, 40K 창에서는
// 임계를 넘은 뒤 매 턴 요약 호출이 붙고 요약이 턴마다 달라지고 "접었습니다" 알림이
// 매번 떴다. 접은 자리를 남기면 그 뒤로는 모델 호출 없이 같은 앞부분을 재구성하고,
// 접힌 뒤 구간이 다시 찰 때만 새로 접는다.

import { countProviderTokens, runProviderText } from '../providers/index.ts';
import { expandToolHistory } from '../providers/toolHistory.ts';
import type { SessionModelMessage, SessionToolCall } from '../session/storage.ts';
import type { Session, SessionCompaction } from '../session/types.ts';

/**
 * 원문으로 남길 최근 사용자 턴 수.
 *
 * 진행 중인 턴 하나만 남긴다. 예전 값 4는 창이 20만인 모델 기준이었다 — 40K 창에서는
 * 파일 읽기가 든 턴 넷이 12k를 넘겨, 접고 나서도 절반이 차 있었다. 진행 중인 턴은
 * 원문으로 둔다: 턴 도중에 접힐 수 있는데, 방금 읽은 파일이 요약으로 바뀌면
 * 하던 작업의 근거가 사라진다. 그 앞은 요약과 요청 원문 목록으로 충분하다.
 * 그 턴이 길면 최근 도구 라운드만 남기고 오래된 라운드도 접는다 (splitForFold).
 */
export const KEEP_RECENT_TURNS = 1;

/**
 * 접기 전에 남겨 두는 자리. 창에 대한 비율과 최솟값 중 큰 쪽이다.
 *
 * 예전에는 창의 70%를 넘으면 접었다. 일찍 접을수록 한 번에 비우는 양이 적어 자주
 * 접게 되고, 접을 때마다 요약을 한 번 더 거쳐 손실이 쌓인다. 이제는 요약 요청(대화
 * 전체와 지시, 요약 출력)이 들어갈 자리만 남기고 최대한 늦게 접는다. 262K 창이면
 * 90% 부근이다. 작은 창은 한 라운드에 들어오는 양에 비해 여유가 적어 최솟값을
 * 둔다 (41K 창이면 예전과 비슷한 70% 부근)
 */
const COMPACT_HEADROOM_RATIO = 0.1;
const MIN_COMPACT_HEADROOM_TOKENS = 12_000;

/**
 * 압축문에 붙이는 요청 원문 목록의 전체 예산 (창에 대한 비율).
 *
 * 요청은 원문 그대로 모아 두고 압축문을 만들 때만 이 예산에 맞춘다. 예전에는 한 건당
 * 600자로 잘랐다. 문서를 통째로 붙여 넣은 요청 때문이었지만, 긴 지시가 든 보통 요청까지
 * 잘렸다. 예산 안이면 전부 원문이고, 넘칠 때만 긴 요청부터 앞뒤를 남기고 줄인다
 */
const PROMPT_BUDGET_RATIO = 0.05;
/** 창을 모를 때의 요청 목록 예산이자, 작은 창에서도 남기는 최소 분량 (글자 수) */
const MIN_PROMPT_BUDGET_CHARS = 8_000;
/** 줄일 때도 한 건을 이보다 짧게 만들지 않는다. 무엇을 시켰는지는 알아볼 수 있어야 한다 */
const MIN_PROMPT_KEEP_CHARS = 300;

/**
 * 요약 출력 예산. 접히는 양에 비례하되 최소와 최대 사이로 둔다.
 *
 * 예전 700토큰은 대화가 수십만 토큰이어도 그만큼으로 줄였다. 요약이 접힌 부분을
 * 대신하므로 요약에 없는 것은 잊힌다
 */
const SUMMARY_TOKENS_RATIO = 0.04;
const SUMMARY_MIN_TOKENS = 2_000;
const SUMMARY_MAX_TOKENS = 8_000;
/**
 * 요약은 본 요청과 같은 추론 강도로 부른다 (앞부분 캐시를 타려고). 추론도 출력
 * 한도를 쓰므로 그 자리를 따로 둔다
 */
const SUMMARY_REASONING_ALLOWANCE = 8_000;
/** 요약 요청에서 이력 밖에 드는 몫: 요약 지시(1천 토큰 남짓)와 도구 정의 어림의 오차 */
const SUMMARY_PROMPT_MARGIN_TOKENS = 4_096;

/**
 * 도구 결과 하나가 차지할 수 있는 몫 (창에 대한 비율).
 *
 * 도구마다 출력 상한이 있지만 창 크기와 무관한 고정값이다. 문서 변환은 상한이 아예
 * 없어 1만 행 엑셀 하나가 262K 창의 세 배로 들어왔고, read_process는 10만 자까지
 * 돌려줘 40K 창이면 한 번에 넘친다. 어떤 도구가 무엇을 돌려주든 결과 하나가 이 몫을
 * 넘으면 앞뒤만 남긴다
 */
const TOOL_RESULT_WINDOW_SHARE = 0.25;
/** 창이 작아도 결과 하나를 이보다 짧게 자르지 않는다. 파일 한 번 읽기의 상한(DEFAULT_READ_CHARS)과 같다 */
const MIN_TOOL_RESULT_CHARS = 20_000;
/** 보내는 사본을 창에 맞출 때 결과 하나를 이보다 짧게 줄이지 않는다. 무엇이 나왔는지는 알아볼 수 있어야 한다 */
const MIN_TOOL_RESULT_KEEP_CHARS = 2_000;
/** 창에 맞추며 다시 재는 횟수. 글자와 토큰의 비율을 어림해 덜어 내므로 한 번에 맞지 않을 수 있다 */
const FIT_ATTEMPTS = 3;

/**
 * 대화 전체로 요약하지 못했을 때 쓰는 옛 방식의 재료 한도. 대화를 글로 풀어 한 번에
 * 넘기므로, 창에 들어가게 총량과 메시지당 길이를 제한한다
 */
const MAX_SOURCE_CHARS = 20_000;
const MAX_SOURCE_MESSAGE_CHARS = 1_200;

/**
 * 문자 수로 토큰을 어림할 때 쓰는 비율 (글자 수 ÷ 이 값 = 토큰 수).
 *
 * 제공자가 정확히 세 주면(countProviderTokens) 이 값은 쓰이지 않는다. 셀 수
 * 없을 때의 폴백이다.
 *
 * 실측(qwen3-8b-awq): 한국어 산문 1.48자/토큰, 코드 4.15자/토큰. 나누는 값이
 * 클수록 토큰을 적게 세므로, 큰 값을 쓰면 늦게 접는다 — 늦게 접으면 턴이
 * 통째로 죽고, 일찍 접으면 맥락을 조금 잃을 뿐이다. 그래서 한국어 쪽에 가깝게
 * 잡는다. (예전 값 2.5는 한국어를 1.7배 적게 세서 압축이 걸리지 않았다)
 */
const DEFAULT_CHARS_PER_TOKEN = 1.6;

/**
 * 출력용으로 늘 비워 두는 자리.
 *
 * 남은 공간이 0이어도 요청은 나간다. vLLM은 입력이 창을 넘으면 거절하고, 넘지
 * 않아도 생성할 자리가 없으면 아무것도 못 만든다. 이만큼은 남겨 두고 접는다.
 */
export const OUTPUT_RESERVE_TOKENS = 4_096;

/**
 * 이미지 한 장을 글자 수로 친 값. 이미지는 base64 길이가 아니라 해상도로 토큰이
 * 매겨진다 (보통 1~2천 토큰). base64를 글자로 세면 스크린샷 한 장이 수십만 글자가 돼
 * 창이 남았는데도 접는다
 */
const IMAGE_CHARS_ESTIMATE = 2_500;

export function messageChars(messages: SessionModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += String(message.content ?? '').length;
    total += (message.images?.length ?? 0) * IMAGE_CHARS_ESTIMATE;
    // 도구 결과가 이력의 대부분을 차지하는 일이 흔하다. 파일 네 번 읽고
    // 27,000 토큰이 들어와 창이 한 라운드 만에 찬 적이 있다.
    // 자식 호출(children)은 화면용이라 모델에게 가지 않으므로 세지 않는다
    for (const { children: _children, images, ...call } of message.toolCalls ?? []) {
      total += JSON.stringify(call).length + (images?.length ?? 0) * IMAGE_CHARS_ESTIMATE;
    }
  }
  return total;
}

/**
 * 지금 이력이 몇 토큰쯤 되는지.
 *
 * charsPerToken을 넘기면 그 비율을 쓴다 — 직전 라운드에서 "보낸 글자 수"와
 * "usage가 알려준 입력 토큰"을 알면 그 세션·그 모델의 실제 비율이 나온다.
 */
export function estimateTokens(
  messages: SessionModelMessage[],
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number {
  const ratio = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil(messageChars(messages) / ratio);
}

/**
 * 이력이 몇 토큰인지. 셀 수 있으면 제공자에게 묻고(vLLM의 /tokenize), 아니면
 * 어림한다. /compact가 접기 전후를 재서 몇 토큰을 비웠는지 보여 줄 때 쓴다
 */
export async function measureHistoryTokens(
  session: { model: string; provider: string },
  history: SessionModelMessage[],
): Promise<number> {
  const counted = await countProviderTokens(session, expandToolHistory(history, session.provider));
  return counted ?? estimateTokens(history);
}

/** 이 토큰 수를 넘으면 접는다. 요약 요청이 들어갈 자리만 남긴 값이다 */
export function compactThreshold(contextWindow: number): number {
  const headroom = Math.max(
    Math.ceil(contextWindow * COMPACT_HEADROOM_RATIO),
    MIN_COMPACT_HEADROOM_TOKENS,
  );
  return contextWindow - headroom;
}

/**
 * 지금 접어야 하는가. 남은 자리가 요약 요청을 겨우 담을 만큼이 되면 접는다.
 * 남겨 두는 자리가 출력 예약분(OUTPUT_RESERVE_TOKENS)보다 넓어, 접지 않아 요청이
 * 거절되는 일도 함께 막는다
 */
export function shouldCompact(estimatedTokens: number, contextWindow: number): boolean {
  if (!contextWindow || contextWindow <= 0) return false;
  return estimatedTokens > compactThreshold(contextWindow);
}

/** 요청 원문 목록의 예산 (글자 수) */
export function promptBudgetChars(contextWindow: number): number {
  if (!contextWindow || contextWindow <= 0) return MIN_PROMPT_BUDGET_CHARS;
  return Math.max(
    MIN_PROMPT_BUDGET_CHARS,
    Math.floor(contextWindow * PROMPT_BUDGET_RATIO * DEFAULT_CHARS_PER_TOKEN),
  );
}

/**
 * 글 목록을 예산에 맞춘다. 짧은 글은 그대로 두고, 긴 글만 같은 길이 상한까지 줄인다.
 * 가장 긴 것부터 줄어드는 셈이다. 상한은 합이 예산에 드는 가장 큰 값으로 잡는다.
 * 최소 분량(minKeep)으로 줄여도 넘치면 예산을 넘기더라도 그 분량은 남긴다
 */
function fitTextsToBudget(
  texts: string[],
  budgetChars: number,
  minKeep: number,
  shrink: (text: string, cap: number) => string,
): string[] {
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  if (total <= budgetChars) return texts;
  const fits = (cap: number) =>
    texts.reduce((sum, text) => sum + Math.min(text.length, cap), 0) <= budgetChars;
  let low = minKeep;
  let high = Math.max(...texts.map(text => text.length));
  if (fits(low)) {
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
  }
  return texts.map(text => shrink(text, low));
}

/** 요청 목록을 예산에 맞춘다. 한 건을 MIN_PROMPT_KEEP_CHARS보다 짧게 만들지 않는다 */
export function fitPromptsToBudget(prompts: string[], budgetChars: number): string[] {
  return fitTextsToBudget(prompts, budgetChars, MIN_PROMPT_KEEP_CHARS, shrinkPrompt);
}

/** 앞쪽을 더 많이 남긴다. 붙여 넣은 로그는 끝에 결론이 있어 뒤도 조금 남긴다 */
function shrinkPrompt(prompt: string, cap: number): string {
  if (prompt.length <= cap) return prompt;
  const head = Math.ceil(cap * 0.6);
  const tail = cap - head;
  return `${prompt.slice(0, head)}\n…(원문 ${prompt.length}자 중 가운데 ${prompt.length - cap}자 생략)…\n${prompt.slice(-tail)}`;
}

/** 도구 결과 하나의 글자 상한 (TOOL_RESULT_WINDOW_SHARE) */
export function toolResultCapChars(contextWindow: number): number {
  if (!contextWindow || contextWindow <= 0) return MIN_TOOL_RESULT_CHARS;
  return Math.max(
    MIN_TOOL_RESULT_CHARS,
    Math.floor(contextWindow * TOOL_RESULT_WINDOW_SHARE * DEFAULT_CHARS_PER_TOKEN),
  );
}

/**
 * 상한을 넘는 도구 결과의 가운데를 덜어 낸다. 앞쪽을 더 많이 남기고, 명령 출력은
 * 끝에 결론(오류, 합계)이 있어 뒤도 남긴다.
 *
 * 생략했다는 안내는 맨 앞에 둔다. 가운데에만 두면 모델이 지나친다. 1만 행 표의 777번째
 * 행이 생략된 가운데에 들어가자, 모델은 보이는 77번째 행을 777번째로 읽고 답했다
 */
export function clipToolResult(text: string, capChars: number): string {
  if (text.length <= capChars) return text;
  const head = Math.ceil(capChars * 0.6);
  const tail = capChars - head;
  const omitted = text.length - capChars;
  return [
    `[도구 결과 ${text.length}자 중 가운데 ${omitted}자 생략. 앞 ${head}자와 뒤 ${tail}자만 보입니다. 찾는 내용이 생략된 부분에 있을 수 있으니, 보이는 것으로 짐작하지 말고 범위를 좁히거나 찾을 말을 주어 다시 요청하세요]`,
    text.slice(0, head),
    `…(가운데 ${omitted}자 생략)…`,
    tail > 0 ? text.slice(-tail) : '',
  ].join('\n');
}

/** 요약 출력 예산 (토큰) */
export function summaryBudgetTokens(foldedTokens: number): number {
  return Math.min(
    SUMMARY_MAX_TOKENS,
    Math.max(SUMMARY_MIN_TOKENS, Math.ceil(foldedTokens * SUMMARY_TOKENS_RATIO)),
  );
}

/**
 * 사용자가 직접 친 프롬프트만 순서대로, 원문 그대로 모은다. 길이는 압축문을 만들 때
 * 예산에 맞춘다 (fitPromptsToBudget).
 *
 * 도구 결과나 파일 내용은 assistant 메시지의 toolCalls에 들어 있어 여기 섞이지
 * 않는다. 붙여 넣은 이미지도 content가 아니라 images에 있다.
 */
export function collectUserPrompts(messages: SessionModelMessage[]): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    // 자동 알림(보조 에이전트 보고)은 사용자가 친 요청이 아니다
    if (message.role !== 'user' || message.automatic) continue;
    const text = String(message.content ?? '').trim();
    if (text) prompts.push(text);
  }
  return prompts;
}

/**
 * 최근 keepTurns개의 사용자 턴을 경계로 이력을 가른다.
 *
 * 턴의 시작은 끼어들지 않은 사용자 메시지다. 끼어든 메시지(interjected)는 이미
 * 진행 중인 턴에 붙는 것이라 새 턴으로 세지 않는다 — 그걸 경계로 삼으면 한
 * 턴이 중간에서 잘린다. 자동 알림(automatic)도 앞 작업의 연장이라 같다.
 */
export function splitForCompaction(
  messages: SessionModelMessage[],
  keepTurns = KEEP_RECENT_TURNS,
): { older: SessionModelMessage[]; recent: SessionModelMessage[] } {
  const starts: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user' && !message.interjected && !message.automatic) starts.push(index);
  }

  if (starts.length <= keepTurns) return { older: [], recent: messages };
  const cut = starts[starts.length - keepTurns];
  return { older: messages.slice(0, cut), recent: messages.slice(cut) };
}

/**
 * 접을 자리를 정한다. 최근 keepTurns개의 사용자 턴을 원문으로 두되, keepToolRounds를
 * 주면 도구 라운드 기준 경계가 더 뒤일 때 거기서 가른다 — 지난 턴과 진행 중인 턴의
 * 오래된 라운드를 한 번에 접는다.
 *
 * 예전에는 진행 중인 턴을 통째로 원문으로 남겨, 턴 하나가 길어지면 접을 것이 없었다.
 * 요청 원문은 요청 목록으로 남기 때문에 무엇을 시켰는지는 잃지 않고, 방금 한 일은
 * 최근 라운드 원문으로 이어진다. 라운드는 메시지 단위라 도구 호출과 결과의 짝이
 * 깨지지 않는다
 */
export function splitForFold(
  messages: SessionModelMessage[],
  { keepToolRounds, keepTurns = KEEP_RECENT_TURNS }: { keepToolRounds?: number; keepTurns?: number } = {},
): { older: SessionModelMessage[]; recent: SessionModelMessage[] } {
  const byTurn = splitForCompaction(messages, keepTurns);
  if (keepToolRounds === undefined) return byTurn;
  const rounds: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant' && message.toolCalls?.length) rounds.push(index);
  }
  if (rounds.length <= keepToolRounds) return byTurn;
  const cut = keepToolRounds > 0 ? rounds[rounds.length - keepToolRounds] : messages.length;
  if (cut <= byTurn.older.length) return byTurn;
  return { older: messages.slice(0, cut), recent: messages.slice(cut) };
}

/**
 * 요약 재료에 적을 도구 호출의 핵심 인자. 이 순서로 처음 있는 것 하나만 쓴다.
 *
 * 이름만 적으면 "read_file을 세 번 했다"까지만 남고 무엇을 읽었는지가 사라진다.
 * 접힌 뒤 "처음 읽은 파일이 뭐였지"에 요약 모델이 지어낸 파일명을 답한 실측
 * 사례가 있다 — 재료에 없는 것을 요약이 알 수는 없다.
 */
const TOOL_NOTE_KEYS = ['path', 'query', 'glob', 'command', 'url'];
/** 경로는 끝(파일명)이 정보라 앞을 자른다 */
const MAX_TOOL_NOTE_CHARS = 60;

function describeToolCall(call: SessionToolCall): string {
  const input = call.input ?? {};
  const key = TOOL_NOTE_KEYS.find(
    name => typeof input[name] === 'string' && String(input[name]).trim() !== '',
  );
  if (!key) return call.name;
  const value = String(input[key]).trim().replace(/\s+/g, ' ');
  const shown =
    value.length > MAX_TOOL_NOTE_CHARS ? `…${value.slice(-MAX_TOOL_NOTE_CHARS)}` : value;
  return `${call.name}(${shown})`;
}

/** 요약을 시킬 재료. 길면 가운데를 덜어낸다 — 시작과 끝이 맥락을 가장 많이 쥐고 있다 */
export function buildSummarySource(messages: SessionModelMessage[]): string {
  const lines = messages.map(message => {
    const who = message.role === 'user' ? '사용자' : '어시스턴트';
    let text = String(message.content ?? '').trim();
    if (text.length > MAX_SOURCE_MESSAGE_CHARS) {
      text = `${text.slice(0, MAX_SOURCE_MESSAGE_CHARS)}…`;
    }
    const tools = (message.toolCalls ?? []).filter(call => call.name).map(describeToolCall);
    const toolNote = tools.length ? ` [도구: ${tools.join(', ')}]` : '';
    return `${who}: ${text}${toolNote}`;
  });

  const joined = lines.join('\n');
  if (joined.length <= MAX_SOURCE_CHARS) return joined;

  const half = Math.floor(MAX_SOURCE_CHARS / 2);
  return `${joined.slice(0, half)}\n\n…(중략)…\n\n${joined.slice(-half)}`;
}

/**
 * 압축된 이력의 첫 메시지 본문. 모델이 받는 압축문 전체이고, 화면의 "압축 완료" 줄을
 * 펼치면 이것을 그대로 보여 준다
 */
export function buildCompactionBrief(
  summary: string,
  prompts: string[],
  promptBudget = MIN_PROMPT_BUDGET_CHARS,
): string {
  const parts = [
    '지금까지의 대화가 길어져 아래로 압축했습니다. 이 내용을 대화의 앞부분으로 여기고 이어서 답하세요.',
  ];

  if (summary.trim()) {
    parts.push('', '## 지금까지의 요약', summary.trim());
  }

  if (prompts.length) {
    parts.push(
      '',
      '## 사용자가 지금까지 요청한 것 (원문, 시간순)',
      '요약보다 이쪽이 우선입니다. 여기 걸린 제약은 따로 취소하기 전까지 계속 유효합니다.',
      ...fitPromptsToBudget(prompts, promptBudget).map((prompt, index) => `${index + 1}. ${prompt}`),
    );
  }

  return parts.join('\n');
}

/**
 * 이번 턴에 새로 접은 결과.
 *
 * 접은 자리를 인덱스가 아니라 마지막으로 접힌 메시지 객체로 넘긴다 — 턴 도중에
 * 접으면 이번 턴의 도구 라운드가 아직 세션에 붙기 전이라 인덱스가 정해지지
 * 않는다. 컨트롤러가 턴 결과를 세션에 넣은 뒤 그 객체의 자리를 찾아
 * SessionCompaction(foldedCount)으로 바꿔 저장한다.
 */
export type CompactionCheckpoint = {
  lastFolded: SessionModelMessage;
  /** 접힌 구간의 사용자 요청 원문 (누적, 자르지 않은 원문) */
  prompts: string[];
  summary: string;
};

/**
 * 세션에 남은 접힌 자리로 앞부분을 재구성한 이력. 모델 호출이 없다.
 * contextWindow는 요청 원문 목록의 예산을 정한다 (0이면 최소 예산)
 */
export function applyCompactionCheckpoint(
  messages: SessionModelMessage[],
  compaction: SessionCompaction,
  contextWindow = 0,
): SessionModelMessage[] {
  if (compaction.foldedCount <= 0 || compaction.foldedCount > messages.length) {
    return [...messages];
  }
  const rest = messages.slice(compaction.foldedCount);
  return [...foldedHead(compaction, rest[0], contextWindow), ...rest];
}

/** 접힌 머리의 두 번째 건. 역할이 번갈아 오지 않으면 거절하는 제공자가 있어 둔다 */
const FOLDED_ACK = '앞부분 요약과 요청 목록을 확인했습니다. 이어서 진행하겠습니다.';

/**
 * 접힌 이력의 머리 — 요약·요청 목록과, 받았다는 한 줄.
 *
 * 받았다는 한 줄은 역할이 번갈아 오게 하려고 두는 것이다. 진행 중인 턴을 라운드
 * 중간에서 접으면 뒤따르는 첫 메시지가 assistant라, 그때 넣으면 오히려 assistant가
 * 두 번 연달아 온다
 */
function foldedHead(
  checkpoint: { prompts: string[]; summary: string },
  next: SessionModelMessage | undefined,
  contextWindow: number,
): SessionModelMessage[] {
  // automatic: 요약은 모델이 도구 결과를 보고 쓴 글이다. 사용자 턴의 시작으로 세거나
  // 분류기에 "사용자의 말"로 넘기면 안 된다
  const brief: SessionModelMessage = {
    automatic: true,
    content: buildCompactionBrief(
      checkpoint.summary,
      checkpoint.prompts,
      promptBudgetChars(contextWindow),
    ),
    role: 'user',
  };
  if (next?.role === 'assistant') return [brief];
  return [brief, { content: FOLDED_ACK, role: 'assistant' }];
}

/** 접힌 이력 앞에 붙은 머리의 길이 (받았다는 한 줄이 있으면 2) */
function foldedHeadLength(messages: SessionModelMessage[]): number {
  return messages[1]?.role === 'assistant' && messages[1].content === FOLDED_ACK ? 2 : 1;
}

/**
 * 압축된 이력을 만든다. 압축할 것이 없으면 원본을 그대로 돌려준다.
 *
 * checkpoint를 주면 messages는 applyCompactionCheckpoint를 거친 이력이어야 한다 —
 * 머리는 합성 메시지라 다시 접는 재료가 아니고, 이전 요약과 요청 목록을
 * 이어받아 그 뒤 구간만 새로 접는다. 요청 원문 목록은 그대로 이어 붙이므로
 * "요약의 요약"이 돼도 사용자가 건 제약은 뭉개지지 않는다.
 *
 * keepToolRounds를 주면 지난 턴과 진행 중인 턴의 오래된 도구 라운드를 한 번에 접는다
 * (splitForFold). systemPrompt와 tools는 본 요청과 같은 값을 넘긴다 — 요약 요청의
 * 앞부분이 본 요청과 같아야 제공자가 계산해 둔 앞부분을 다시 쓴다.
 *
 * 대화 전체로 요약하지 못하면 옛 방식(대화를 글로 풀어 넘기기)으로, 그것도 안 되면
 * 이전 요약(없으면 빈 채로)과 요청 목록만으로 접는다 — 대화를 400으로 죽이는 것보다
 * 요약이 빠진 채로 이어가는 편이 낫다.
 */
export async function compactMessages(
  session: Session,
  messages: SessionModelMessage[],
  {
    checkpoint,
    contextWindow = 0,
    keepToolRounds,
    keepTurns = KEEP_RECENT_TURNS,
    signal,
    systemPrompt,
    tools,
  }: {
    checkpoint?: { prompts: string[]; summary: string };
    contextWindow?: number;
    keepToolRounds?: number;
    keepTurns?: number;
    /** 턴의 중단 신호. 요약 호출을 끊는다 */
    signal?: AbortSignal;
    systemPrompt?: string;
    tools?: unknown[];
  } = {},
): Promise<{
  /** 모델이 받는 압축문 전체 (요약과 요청 원문 목록). 화면이 펼쳐 보여 준다 */
  brief?: string;
  checkpoint?: CompactionCheckpoint;
  compacted: boolean;
  messages: SessionModelMessage[];
  summarized: boolean;
}> {
  const body = checkpoint ? messages.slice(foldedHeadLength(messages)) : messages;
  const { older, recent } = splitForFold(body, { keepToolRounds, keepTurns });
  if (older.length === 0) return { compacted: false, messages, summarized: false };

  const budgetTokens = summaryBudgetTokens(estimateTokens(older));
  let summary = '';
  try {
    summary = await summarizeConversation(session, messages, {
      budgetTokens,
      contextWindow,
      signal,
      systemPrompt,
      tools,
    });
  } catch {
    // 아래의 옛 방식으로 넘어간다
  }
  if (!summary && !signal?.aborted) {
    try {
      summary = await summarizeHistory(session, older, checkpoint?.summary, budgetTokens, signal);
    } catch {
      // 요약은 있으면 좋은 것이지, 없다고 멈출 이유는 아니다
    }
  }
  // 사용자가 멈춰 요약이 끊겼으면 접지 않는다. 요약 없이 접으면 그 구간을 잃는다
  if (signal?.aborted) return { compacted: false, messages, summarized: false };
  if (!summary) summary = checkpoint?.summary ?? '';

  // 프롬프트는 접히는 구간에서만 모은다. 최근 구간은 원문이 그대로 남아 있어
  // 여기에도 넣으면 같은 말이 두 번 간다
  const next: CompactionCheckpoint = {
    lastFolded: older[older.length - 1],
    prompts: [...(checkpoint?.prompts ?? []), ...collectUserPrompts(older)],
    summary,
  };
  const head = foldedHead(next, recent[0], contextWindow);

  return {
    brief: String(head[0].content),
    checkpoint: next,
    compacted: true,
    messages: [...head, ...recent],
    summarized: summary.trim() !== '',
  };
}

/**
 * 대화 전체로 요약한다. 도구 결과까지 실제 대화 그대로 넘기고 끝에 요약 지시를 붙인다.
 *
 * 예전에는 대화를 글로 풀어 2만 자까지만 넘겼다 (메시지당 1,200자, 도구 결과는 이름만).
 * 수십만 토큰짜리 대화도 요약기가 본 재료는 그만큼이었다. 앞부분(시스템 프롬프트,
 * 도구 정의, 대화)을 본 요청과 똑같이 두면 제공자가 방금 계산해 둔 앞부분을 다시
 * 쓰므로 처음부터 다시 읽지 않는다. 추론 강도도 그래서 본 요청과 같게 둔다.
 *
 * 요약 요청도 창 안이어야 한다. 접는 시점의 이력은 이미 접는 선을 넘겼고, 요약 출력
 * 자리까지 더하면 창을 넘기기 쉽다. 넘기면 거절되어 옛 방식(발췌 요약)으로 떨어진다.
 * 넘칠 때만 도구 결과의 가운데를 덜어 낸다. 오래된 결과를 한 줄로 바꾸면 거기서만
 * 나온 사실이 요약에서 빠진다
 */
async function summarizeConversation(
  session: Session,
  history: SessionModelMessage[],
  {
    budgetTokens,
    contextWindow,
    signal,
    systemPrompt,
    tools,
  }: {
    budgetTokens: number;
    contextWindow: number;
    signal?: AbortSignal;
    systemPrompt?: string;
    tools?: unknown[];
  },
): Promise<string> {
  const maxTokens = budgetTokens + SUMMARY_REASONING_ALLOWANCE;
  const fitted =
    contextWindow > 0
      ? (
          await fitHistoryToWindow(history, {
            measure: candidate => measureRequestTokens(session, candidate, systemPrompt, tools),
            targetTokens: contextWindow - maxTokens - SUMMARY_PROMPT_MARGIN_TOKENS,
          })
        ).history
      : history;
  const raw = await runProviderText(session, {
    keepReasoning: true,
    maxTokens,
    messages: [
      ...expandToolHistory(fitted, session.provider),
      { content: summaryInstruction(budgetTokens), role: 'user' },
    ],
    signal,
    systemPrompt,
    ...(tools ? { tools } : {}),
  });
  return String(raw ?? '').trim();
}

/**
 * 이 이력을 시스템 프롬프트, 도구 정의와 함께 보내면 몇 토큰인지. 루프의 실측과 같은
 * 방식이다. 셀 수 있으면 시스템 프롬프트까지 제공자에게 묻고, 도구 정의는 /tokenize에
 * 넣을 수 없어 글자 수로 어림한다
 */
async function measureRequestTokens(
  session: Session,
  history: SessionModelMessage[],
  systemPrompt = '',
  tools?: unknown[],
): Promise<number> {
  const toolsChars = tools ? JSON.stringify(tools).length : 0;
  const counted = await countProviderTokens(session, [
    { role: 'system', content: systemPrompt },
    ...expandToolHistory(history, session.provider),
  ]);
  return counted === null
    ? estimateTokens(history) + Math.ceil((systemPrompt.length + toolsChars) / 3)
    : counted + Math.ceil(toolsChars / 3);
}

/**
 * 요약 지시. 요약이 접힌 부분을 대신하므로, 이어서 일하는 데 필요한 것을 정해 둔
 * 항목별로 남기게 한다. 사용자 메시지 원문은 코드가 따로 붙이므로 옮겨 적지 않게 한다
 */
function summaryInstruction(budgetTokens: number): string {
  // 한국어 기준의 대략적인 글자 수. 한도는 maxTokens가 지키고, 이 숫자는 분량의 눈대중이다
  const chars = Math.round(budgetTokens * DEFAULT_CHARS_PER_TOKEN);
  return [
    '[요약 요청 — 앱이 보낸 지시입니다. 대화가 길어져 앞부분을 요약으로 바꿉니다.]',
    '지금까지의 대화를, 이 요약만 보고도 작업을 그대로 이어 갈 수 있게 요약하세요. 요약에 없는 것은 잊힙니다.',
    '도구를 부르지 말고 요약 본문만 쓰세요. 맨 앞에 "지금까지의 요약"이 있으면 그 내용도 새 요약에 포함하세요.',
    '사용자가 보낸 메시지 원문은 요약 뒤에 따로 목록으로 붙으니 다시 옮겨 적지 마세요. 대신 사용자의 의도가 어떻게 바뀌었는지와 사용자가 지적한 것은 적으세요.',
    '',
    '아래 제목과 순서로 쓰세요. 내용이 없는 항목은 "없음"이라고 쓰세요.',
    '1. 요청과 의도: 사용자가 원하는 것과 그 의도가 어떻게 바뀌어 왔는지',
    '2. 결정과 이유: 정한 것과 그 이유. 되돌린 결정은 되돌렸다고',
    '3. 파일과 코드: 읽거나 고친 파일의 경로와 무엇을 왜 했는지. 이어서 작업하는 데 필요한 코드는 원문 그대로 짧게 인용',
    '4. 오류와 해결: 겪은 오류 메시지 원문과 고친 방법',
    '5. 시도했다 버린 방법: 무엇이 왜 안 됐는지. 다시 시도하지 않도록',
    '6. 확인한 사실: 명령 결과, 설정값, 버전, 포트, 경로처럼 다시 알아내려면 도구를 또 불러야 하는 것',
    '7. 남은 일: 아직 끝나지 않은 작업',
    '8. 직전 작업: 요약 직전에 정확히 무엇을 하고 있었는지',
    '9. 다음 단계: 바로 이어서 할 일. 사용자의 최근 요청과 직접 이어지는 것만',
    '',
    '파일 경로, 함수 이름, 설정 키, 명령, 오류 메시지 같은 식별자는 원문 그대로 옮기세요.',
    '사용자가 건 제약과 취향은 빠뜨리지 마세요. 서론과 맺음말 없이 내용만 쓰세요.',
    `필요한 만큼 자세히 쓰되, 대략 ${chars.toLocaleString('en-US')}자를 넘기지 마세요.`,
  ].join('\n');
}

async function summarizeHistory(
  session: Session,
  older: SessionModelMessage[],
  previousSummary: string | undefined,
  budgetTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = [
    '아래는 한 대화의 앞부분입니다. 뒤이어 대화를 계속할 수 있도록 요약하세요.',
    '',
    '규칙:',
    '- 무엇을 하려던 대화인지, 어디까지 됐는지, 무엇이 남았는지를 담으세요.',
    '- 결정된 사항과 그 이유를 남기세요. 되돌린 결정은 되돌렸다고 적으세요.',
    '- 파일 경로·함수 이름·설정 키·오류 메시지 같은 식별자는 그대로 옮기세요.',
    '- 사용자가 건 제약과 취향은 빠뜨리지 마세요.',
    '- 목록 형태로, 서론과 맺음말 없이 내용만 쓰세요.',
    // 이미 접힌 앞부분이 있으면 그 요약을 재료의 첫머리에 둔다. 새 요약은 그것까지
    // 포함해야 한다 — 빠지면 접힐 때마다 앞 기억이 지워진다
    ...(previousSummary?.trim()
      ? ['- 아래 "이전 요약"은 그보다 앞선 대화의 요약입니다. 새 요약에 그 내용도 포함하세요.']
      : []),
    '',
    '--- 대화 ---',
    ...(previousSummary?.trim() ? [`[이전 요약]\n${previousSummary.trim()}`, ''] : []),
    buildSummarySource(older),
  ].join('\n');

  const raw = await runProviderText(session, {
    maxTokens: budgetTokens,
    messages: [{ content: prompt, role: 'user' }],
    signal,
  });
  return String(raw ?? '').trim();
}

/**
 * 원문을 유지할 최근 도구 라운드 수.
 *
 * 요약 압축은 최근 턴을 원문으로 남긴다. 그런데 한 턴에서 파일을 여러 번 읽으면
 * 그 최근 구간의 도구 결과만으로 창을 넘긴다. 직전 두 라운드의 결과는 모델이 지금
 * 보고 있는 것이라 남기고, 그보다 오래된 결과는 보내는 사본에서 줄인다. 이력을
 * 접을 때(splitForFold)도 최근 라운드는 이만큼 원문으로 남긴다.
 */
export const KEEP_RECENT_TOOL_ROUNDS = 2;

/** 이보다 짧은 도구 결과는 줄여도 이득이 없다 (안내 문구가 원문만큼 길다) */
const MIN_TRIM_RESULT_CHARS = 200;

/** 도구 호출을 가리키는 키 (도구명 + 인자). 같은 호출인지 가를 때 쓴다 */
export function toolCallKey(name: string, input: unknown): string {
  return `${name} ${JSON.stringify(input)}`;
}

/**
 * 오래된 도구 결과를 한 줄로 줄인 사본을 만든다. 줄일 것이 없으면 원본을 그대로 돌려준다.
 *
 * 화면과 세션에 남는 원문은 건드리지 않는다 — 사용자가 대화를 다시 열었을 때
 * 파일 내용이 사라져 있으면 안 된다. 모델에게 가는 양만 줄이는 것이라 반환값은
 * 보내는 데만 쓴다. 호출과 결과의 짝(id)은 그대로 유지되므로 이력 형식은 깨지지 않는다.
 */
export function trimToolResultsForSend(
  messages: SessionModelMessage[],
  keepRounds = KEEP_RECENT_TOOL_ROUNDS,
  /**
   * 줄인 호출의 키(toolCallKey)를 받는다. 루프는 이 호출을 "변화 없음" 비교에서
   * 뺀다 — 결과가 한 줄로 줄어든 뒤 모델이 같은 파일을 다시 읽으려 하면 원문이
   * 가야지, "결과는 위에 있다"고 하면 갈 곳이 없다
   */
  stubbed?: Set<string>,
): SessionModelMessage[] {
  const toolRounds: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant' && message.toolCalls?.length) toolRounds.push(index);
  }
  if (toolRounds.length <= keepRounds) return messages;
  // 이 인덱스부터는 원문 유지
  const cutoff = keepRounds > 0 ? toolRounds[toolRounds.length - keepRounds] : messages.length;

  let changed = false;
  const trimmed = messages.map((message, index) => {
    if (index >= cutoff || message.role !== 'assistant' || !message.toolCalls?.length) return message;
    const toolCalls = message.toolCalls.map(call => {
      const result = String(call.result ?? '');
      if (result.length < MIN_TRIM_RESULT_CHARS) return call;
      changed = true;
      stubbed?.add(toolCallKey(call.name, call.input));
      return {
        ...call,
        result: `[이전 도구 결과 생략 — ${result.length}자. 다시 필요하면 같은 도구를 다시 호출하세요]`,
      };
    });
    return { ...message, toolCalls };
  });
  return changed ? trimmed : messages;
}

/**
 * 도구 결과를 글자 예산 안으로 줄인 사본을 만든다. 줄일 것이 없으면 원본을 돌려준다.
 *
 * 오래된 결과를 한 줄로 바꾸는 trimToolResultsForSend와 달리 직전 라운드의 결과까지
 * 대상이고, 결과를 지우지 않고 가운데만 덜어 낸다. 짧은 결과는 그대로 두고 긴 결과부터
 * 줄인다 (요청 목록과 같은 방식). 줄인 호출의 키는 stubbed에 넣는다
 */
export function fitToolResults(
  messages: SessionModelMessage[],
  budgetChars: number,
  stubbed?: Set<string>,
): SessionModelMessage[] {
  const results = messages.flatMap(message =>
    (message.toolCalls ?? []).map(call => String(call.result ?? '')),
  );
  const fitted = fitTextsToBudget(results, Math.max(0, budgetChars), MIN_TOOL_RESULT_KEEP_CHARS, clipToolResult);
  if (fitted === results) return messages;

  let cursor = 0;
  let changed = false;
  const next = messages.map(message => {
    if (!message.toolCalls?.length) return message;
    let touched = false;
    const toolCalls = message.toolCalls.map(call => {
      const result = fitted[cursor];
      cursor += 1;
      if (result === String(call.result ?? '')) return call;
      touched = true;
      stubbed?.add(toolCallKey(call.name, call.input));
      return { ...call, result };
    });
    if (!touched) return message;
    changed = true;
    return { ...message, toolCalls };
  });
  return changed ? next : messages;
}

/**
 * 보내는 사본을 목표 토큰 아래로 줄인다. keepRounds를 주면 그보다 오래된 도구 결과를
 * 먼저 한 줄로 바꾸고, 그래도 넘치면 남은 결과의 가운데를 덜어 낸다.
 *
 * 오래된 결과만 줄여서는 직전 라운드의 결과 하나가 창보다 큰 경우를 막지 못한다.
 * 1만 행 엑셀을 통째로 변환한 결과가 그랬고, 그 턴은 다시 보내도 거절되어 멈췄다.
 * 넘친 토큰을 글자로 바꿔 덜어 내고 다시 잰다. 비율은 이번 요청 전체로 어림하는데,
 * 시스템 프롬프트까지 든 토큰으로 나누므로 덜 덜어 내는 쪽으로 틀린다. 모자라면 한 번
 * 더 줄인다. 이력 자체(사용자가 보낸 글 등)가 넘치는 것이면 도구 결과로는 맞출 수 없어
 * 최소 분량까지 줄인 채로 돌려준다
 */
export async function fitHistoryToWindow(
  messages: SessionModelMessage[],
  {
    keepRounds,
    measure,
    stubbed,
    targetTokens,
    tokens,
  }: {
    keepRounds?: number;
    measure: (history: SessionModelMessage[]) => Promise<number>;
    stubbed?: Set<string>;
    targetTokens: number;
    /** messages를 이미 쟀으면 그 값. 오래된 결과를 줄일 것이 없을 때 다시 재지 않는다 */
    tokens?: number;
  },
): Promise<{ history: SessionModelMessage[]; tokens: number }> {
  const base = keepRounds === undefined ? messages : trimToolResultsForSend(messages, keepRounds, stubbed);
  let history = base;
  let measured = base === messages && tokens !== undefined ? tokens : await measure(base);
  for (let attempt = 0; attempt < FIT_ATTEMPTS && measured > targetTokens; attempt += 1) {
    const current = toolResultChars(history);
    const charsPerToken = messageChars(history) / Math.max(1, measured);
    // 어림이 빗나가도 한 번에 들어가게 목표보다 조금 아래를 겨냥한다
    const excessChars = Math.ceil((measured - targetTokens * 0.95) * charsPerToken);
    // 줄인 결과를 다시 줄이지 않고 늘 원문에서 줄인다. 생략 표시가 겹치지 않는다
    const next = fitToolResults(base, current - excessChars, stubbed);
    if (toolResultChars(next) >= current) break;
    history = next;
    measured = await measure(history);
  }
  return { history, tokens: measured };
}

function toolResultChars(messages: SessionModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) total += String(call.result ?? '').length;
  }
  return total;
}
