// 중지 버튼으로 끝난 턴이 모델 이력에 남는지 고정한다.
//
// 중지는 오류가 아니다. 화면에는 질문과 받다 만 답변이 그대로 남으므로, 모델의
// 이력에서만 사라지면 다음 턴은 사용자만 아는 대화 위에서 시작한다. 반대로 오류로
// 끝난 턴은 재전송이 같은 입력을 다시 보내야 해서 지금처럼 되돌린다.
//
// 고정하는 것은 넷이다.
//   1. 중단해도 사용자 프롬프트·끝낸 도구 왕복·받다 만 답변이 남는다.
//   2. 다음 턴이 그 이력을 실제로 받아서 나간다 (이 회귀의 핵심).
//   3. 화면에 나가지 않은 텍스트는 이력에도 남기지 않는다.
//   4. 오류로 끝난 턴은 여전히 사용자 메시지를 되돌린다.

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, expect, mock, test } from 'bun:test';

const HOME = join(tmpdir(), `newbie-abort-test-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

// 가짜 프로바이더는 필요한 것만 덮어쓴다. 통째로 갈아끼우면 loop가 쓰는 다른
// export(countProviderTokens 등)가 사라져 import부터 깨진다
const realProviders = { ...(await import('../src/providers/index.ts')) };

mkdirSync(HOME, { recursive: true });
// 도구가 성공해야 다음 라운드의 텍스트가 버퍼링 없이 화면으로 나간다 (아래 3번 참고)
const TARGET = join(HOME, 'note.md');
writeFileSync(TARGET, '읽히는 파일입니다', 'utf8');
const MISSING = join(HOME, '__no_such_file__.md');

afterAll(() => {
  mock.module('../src/providers/index.ts', () => realProviders);
  try {
    rmSync(HOME, { force: true, recursive: true });
  } catch {
    // Windows에서 파일이 잠겨 있으면 임시 폴더 청소는 포기해도 된다
  }
});

const PARTIAL = '받다 만 답변입니다';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 2라운드가 흘리기 시작한 순간. 고정 시간만 기다리면 턴 준비(환경 정보 수집 등)가
// 조금만 늦어도 답변이 흐르기 전에 중단해 버려 결과가 실행마다 달라진다
let streamStarted: Promise<void> = Promise.resolve();
let markStreamStarted = () => {};

type ProviderState = { calls: number; seen: any[][] };

/**
 * 1라운드는 도구를 부르고, 2라운드는 천천히 흘리다 중단 신호를 받으면 예외로
 * 끝난다 — 실제 프로바이더가 스트리밍 도중 abort될 때와 같은 모양이다.
 * 중단 뒤 이어지는 턴은 그냥 짧게 답한다.
 */
function abortableProvider(options: { toolPath?: string } = {}): ProviderState {
  const state: ProviderState = { calls: 0, seen: [] };
  const path = options.toolPath ?? TARGET;
  streamStarted = new Promise(resolve => {
    markStreamStarted = resolve;
  });
  mock.module('../src/providers/index.ts', () => ({
    ...realProviders,
    runProviderText: async () => '', // 제목 생성은 빈 값 → 스킵
    runProviderTurn: async (session: any, context: any) => {
      state.calls += 1;
      state.seen.push(session.messages);
      if (state.calls === 1) {
        return {
          text: '',
          toolCalls: [{ id: 't1', input: { path }, name: 'read_file' }],
          usage: undefined,
        };
      }
      if (state.calls === 2) {
        markStreamStarted();
        for (const ch of PARTIAL) {
          if (context.signal?.aborted) throw new Error('요청이 중단되었습니다');
          context.output.write(ch);
          await sleep(15);
        }
        return { text: PARTIAL, toolCalls: [], usage: undefined };
      }
      const answer = '이어서 답합니다.';
      context.output.write(answer);
      return { text: answer, toolCalls: [], usage: undefined };
    },
  }));
  return state;
}

async function setup() {
  const { createController } = await import('../app/main/controller.ts');
  const { createSession } = await import('../src/config.ts');
  const storage = await import('../src/session/storage.ts');

  const session = createSession({});
  const controller = createController({ session, emit: () => {}, quit: () => {} });
  return { controller, sessionId: session.sessionId, storage };
}

/** 도구 라운드가 끝나고 답변이 흐르기 시작한 뒤에 중단 */
async function submitThenCancel(controller: any, text: string) {
  const turn = controller.submit(text);
  await streamStarted;
  // 앞부분 몇 글자가 흐를 만큼만 더 기다린다 (테스트가 앞 3글자로 찾는다)
  await sleep(70);
  controller.cancelTurn();
  await turn;
}

test('중단해도 사용자 프롬프트·끝낸 도구 왕복·받다 만 답변이 남는다', async () => {
  abortableProvider();
  const { controller, sessionId, storage } = await setup();

  await submitThenCancel(controller, '이 파일 좀 봐줘');

  const messages = storage.loadSessionById(sessionId).messages;

  // 1. 사용자 프롬프트 — 이게 빠지면 다음 턴에서 맥락이 통째로 끊긴다
  expect(messages[0].role).toBe('user');
  expect(messages[0].content).toBe('이 파일 좀 봐줘');

  // 2. 끝낸 도구 라운드. 호출만 남고 결과가 없으면 짝이 깨져 다음 요청이 거절된다
  const withTools = messages.filter(message => message.toolCalls?.length);
  expect(withTools.length).toBe(1);
  const call = withTools[0].toolCalls![0];
  expect(call.name).toBe('read_file');
  expect(call.result === undefined).toBe(false);

  // 3. 받다 만 답변
  expect(messages.at(-1)!.role).toBe('assistant');
  expect(PARTIAL.startsWith(String(messages.at(-1)!.content))).toBe(true);
  expect(String(messages.at(-1)!.content).length).toBeGreaterThan(0);
});

test('중단된 답변은 세션을 다시 열어도 한 번만, assistant 행으로 남는다', async () => {
  // 받다 만 답변은 recordSessionMessages로 모델 이력에 남고, 화면 행은
  // loadSession이 그 이력에서 재구성한다(assistant, 마크다운 렌더링). 여기에
  // 더해 같은 내용을 system 행으로 또 남기면(recordSessionRow) 다시 열었을 때
  // 렌더링된 것과 안 된 것 두 벌로 겹쳐 보인다 — 이 회귀를 고정한다
  abortableProvider();
  const { controller, sessionId, storage } = await setup();

  await submitThenCancel(controller, '이 파일 좀 봐줘');

  const rows = storage.loadSessionById(sessionId).rows;
  // 중단 시점까지 흐른 건 PARTIAL의 앞부분뿐이라 짧은 접두어로 찾는다 (타이밍에
  // 안 흔들리도록 3, 4번째 테스트와 같은 방식). 이 접두어를 담은 행이 둘이면
  // 받다 만 답변이 assistant 행(재구성)과 system 행(공지)에 겹쳐 남은 것이다
  const prefix = PARTIAL.slice(0, 3);
  const withPartial = rows.filter(row => String(row.content ?? '').includes(prefix));
  expect(withPartial.length).toBe(1);
  expect(withPartial[0].role).toBe('assistant');

  // 중단 안내는 받다 만 답변과 겹치지 않는 별도의 짧은 행이어야 한다
  const noticeIndex = rows.findIndex(
    row => row.role === 'system' && row.content === '(요청을 중단했습니다)',
  );
  expect(noticeIndex).toBeGreaterThanOrEqual(0);

  // 파일에 쓰는 순서가 뒤집히면(안내를 이 턴의 이력보다 먼저 적으면) 다시 열 때도
  // 그 순서 그대로 읽혀 안내가 이번 턴의 사용자 프롬프트보다 위에 그려진다.
  // 사용자 프롬프트·받다 만 답변이 안내보다 앞서 있어야 한다
  const userIndex = rows.findIndex(row => row.role === 'user' && row.content === '이 파일 좀 봐줘');
  expect(userIndex).toBeGreaterThanOrEqual(0);
  expect(userIndex).toBeLessThan(noticeIndex);
  expect(withPartial[0]).toBe(rows[noticeIndex - 1]);
});

test('중단 뒤 이어지는 턴이 앞 대화를 그대로 받아서 나간다', async () => {
  const state = abortableProvider();
  const { controller } = await setup();

  await submitThenCancel(controller, '이 파일 좀 봐줘');
  await controller.submit('아까 그거 계속해줘');

  // 이어지는 턴이 모델에게 실제로 보낸 이력
  const sent = state.seen.at(-1)!;
  const roles = sent.map((message: any) => message.role);
  expect(roles[0]).toBe('user');
  expect(sent[0].content).toBe('이 파일 좀 봐줘');
  // 이력은 프로바이더 포맷으로 펼쳐져 나가므로(expandToolHistory) 도구 왕복은
  // toolCalls 필드가 아니라 펼쳐진 본문에서 확인한다
  expect(JSON.stringify(sent)).toContain('read_file');
  // 맨 끝에는 매 턴 붙는 환경 정보가 오므로 그 앞이 사용자의 말이다
  expect(sent.filter((m: any) => !String(m.content).startsWith('[환경 정보')).at(-1).content).toBe('아까 그거 계속해줘');
});

test('화면에 나가지 않은 텍스트는 이력에도 남기지 않는다', async () => {
  // 도구가 실패한 직후 라운드는 정체 재촉으로 폐기될 수 있어 버퍼에 모았다가
  // 확정 후에야 화면으로 나간다. 중단으로 그 확정에 못 닿았으면 사용자도 못 본
  // 텍스트이므로 이력에도 들어가면 안 된다
  abortableProvider({ toolPath: MISSING });
  const { controller, sessionId, storage } = await setup();

  await submitThenCancel(controller, '이 파일 좀 봐줘');

  const messages = storage.loadSessionById(sessionId).messages;
  expect(messages[0].role).toBe('user'); // 프롬프트와 도구 왕복은 그대로 남는다
  expect(messages.some(message => message.toolCalls?.length)).toBe(true);
  // 빈 assistant 메시지를 남기면 다음 요청에 빈 턴이 실려 나간다
  const empty = messages.filter(
    message =>
      message.role === 'assistant' && !String(message.content ?? '').trim() && !message.toolCalls?.length,
  );
  expect(empty.length).toBe(0);
  expect(JSON.stringify(messages)).not.toContain(PARTIAL.slice(0, 3));
});

test('오류로 끝난 턴은 재전송을 위해 사용자 메시지를 되돌린다', async () => {
  mock.module('../src/providers/index.ts', () => ({
    ...realProviders,
    runProviderText: async () => '',
    runProviderTurn: async () => {
      throw new Error('제공자가 500을 돌려주었습니다');
    },
  }));
  const { controller, sessionId, storage } = await setup();

  await controller.submit('실패할 요청');

  const reloaded = storage.loadSessionById(sessionId);
  // 오류 경로는 지금 동작 그대로 — 모델 이력에는 아무것도 남기지 않는다
  expect(reloaded.messages.length).toBe(0);
  // 화면에는 오류 행이 남아 재전송 버튼이 붙는다
  expect(reloaded.rows.some(row => row.role === 'error')).toBe(true);
});
