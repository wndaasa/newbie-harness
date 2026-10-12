// 진행 중인 턴 도중 세션을 전환했을 때의 동작 회귀 테스트.
//
// 전환해도 턴은 끊기지 않는다. 자기 세션 객체를 쥐고 백그라운드에서 끝까지 돌아
// 원래 세션 파일에 기록하고, 화면 이벤트는 그 세션을
// 보고 있을 때만 나간다. 여기서 고정하는 것은 세 가지다.
//   1. 옮겨간 세션에는 아무것도 새지 않는다 (메모리·파일·화면).
//   2. 원래 세션에는 턴 결과가 온전히 남는다.
//   3. 돌고 있는 세션으로 돌아오면 화면이 진행 중인 상태 그대로 되살아난다.
//
// mock 프로바이더가 abort 신호를 무시하고 끝까지 완주하는 최악의 경우를 만들어
// 격리를 검사한다.

// NEWBIE_HOME을 임시 경로로 돌려 실제 사용자 데이터(~/.newbie)와 격리한다.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { afterAll, expect, mock, test } from 'bun:test';

const HOME = join(tmpdir(), `newbie-switch-test-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

// 이 파일이 갈아끼운 프로바이더 목은 같은 프로세스에서 도는 다른 테스트 파일에도
// 그대로 남는다. 실제로 진짜 프로바이더로 로컬 서버를 부르는 distillCheckpoint가
// 빈 응답을 받아 깨졌다. 끝나면 원본으로 되돌린다
const realProviders = { ...(await import('../src/providers/index.ts')) };
afterAll(() => {
  mock.module('../src/providers/index.ts', () => realProviders);
});

afterAll(() => {
  try {
    rmSync(HOME, { force: true, recursive: true });
  } catch {
    // Windows에서 파일이 잠겨 있으면 임시 폴더 청소는 포기해도 된다
  }
});

const LEAK = '오염될 답변입니다';

// 답변이 흐르기 시작한 순간. 고정 시간만 기다리면 턴 준비가 조금만 늦어도
// 첫 글자가 나오기 전에 전환해 버려 결과가 실행마다 달라진다
let firstChunk: Promise<void> = Promise.resolve();

// abort를 무시하고 끝까지 스트리밍을 완주하는 프로바이더 (최악의 경우)
function slowProvider(behavior: { throwAfterMs?: number } = {}) {
  let markFirstChunk = () => {};
  firstChunk = new Promise(resolve => {
    markFirstChunk = resolve;
  });
  mock.module('../src/providers/index.ts', () => ({
    runProviderText: async () => '', // 제목 생성은 빈 값 → 스킵
    runProviderTurn: async (_session: unknown, context: any) => {
      markFirstChunk();
      for (const ch of LEAK) {
        context.output.write(ch);
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      if (behavior.throwAfterMs !== undefined) {
        await new Promise(resolve => setTimeout(resolve, behavior.throwAfterMs));
        throw new Error('요청이 중단되었습니다');
      }
      return { text: LEAK, toolCalls: [], usage: undefined };
    },
  }));
}

async function setup() {
  const { createController } = await import('../app/main/controller.ts');
  const { createSession } = await import('../src/config.ts');
  const storage = await import('../src/session/storage.ts');

  // 전환해 갈 "다른 세션" 파일을 미리 만들어 둔다
  const other = {
    ...storage.createSessionPersistence(),
    mock: false,
    mode: 'agent',
  } as any;
  storage.recordSessionMessages(other, [
    { role: 'user', content: '기존 대화' },
    { role: 'assistant', content: '기존 답변' },
  ]);

  const events: any[] = [];
  const session = createSession({});
  const controller = createController({
    session,
    emit: event => events.push(event),
    quit: () => {},
  });
  // 컨트롤러가 "지금 보고 있는" 세션 id는 session-meta 이벤트로 알 수 있다
  const viewingId = () =>
    [...events].reverse().find(event => event.type === 'session-meta')?.sessionId;
  return { controller, events, originalId: session.sessionId, otherId: other.sessionId, storage, viewingId };
}

test('턴 도중 세션을 전환해도 이전 턴의 결과가 새 세션에 새지 않고, 원래 세션에는 끝까지 기록된다', async () => {
  slowProvider();
  const { controller, events, originalId, otherId, storage, viewingId } = await setup();

  const turn = controller.submit('안녕하세요');
  // 스트리밍이 시작될 때까지 잠깐 기다렸다가 다른 세션으로 전환
  await new Promise(resolve => setTimeout(resolve, 40));
  controller.resumeSession(otherId);
  const switchedAt = events.length;
  await turn;

  // 1. 화면은 옮겨간 세션을 보고 있고, 그쪽 파일은 그대로다
  expect(viewingId()).toBe(otherId);
  const reloaded = storage.loadSessionById(otherId);
  expect(reloaded.messages.length).toBe(2);
  expect(JSON.stringify(reloaded.messages)).not.toContain(LEAK);

  // 2. 전환 이후로 이전 턴의 행 갱신이 화면에 나가지 않았다
  const rowsAfterSwitch = events
    .slice(switchedAt)
    .filter((event: any) => String(event.type).startsWith('row'));
  expect(JSON.stringify(rowsAfterSwitch)).not.toContain(LEAK);

  // 3. 원래 세션에는 턴이 끝까지 돌아 기록됐다 (버리지 않는다)
  const original = storage.loadSessionById(originalId);
  expect(original.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  expect(original.messages[1].content).toBe(LEAK);
});

test('전환 후 이전 턴이 예외로 끝나도 새 세션의 메시지를 지우지 않는다', async () => {
  slowProvider({ throwAfterMs: 30 });
  const { controller, events, originalId, otherId, storage } = await setup();

  const turn = controller.submit('안녕하세요');
  await new Promise(resolve => setTimeout(resolve, 40));
  controller.resumeSession(otherId);
  const switchedAt = events.length;
  await turn;

  // 옮겨간 세션은 무사하다
  expect(storage.loadSessionById(otherId).messages.length).toBe(2);
  // 중단 안내 행이 새 대화 화면에 붙지 않는다
  const rowsAfterSwitch = events
    .slice(switchedAt)
    .filter((event: any) => String(event.type).startsWith('row'));
  expect(JSON.stringify(rowsAfterSwitch)).not.toContain('오류');
  // 오류는 원래 세션에 남는다
  const original = storage.loadSessionById(originalId);
  expect(original.rows.some(row => row.role === 'error')).toBe(true);
});

test('돌고 있는 세션으로 돌아오면 진행 중인 행과 작업 중 상태가 되살아난다', async () => {
  slowProvider();
  const { controller, events, originalId, otherId, viewingId } = await setup();

  const turn = controller.submit('안녕하세요');
  await firstChunk;
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.resumeSession(otherId);
  await new Promise(resolve => setTimeout(resolve, 20));
  // 아직 턴이 도는 중에 원래 세션으로 돌아온다
  const returnedAt = events.length;
  controller.resumeSession(originalId);

  expect(viewingId()).toBe(originalId);
  const restored = events.slice(returnedAt).find((event: any) => event.type === 'rows:set');
  const roles = restored.rows.map((row: any) => row.role);
  // 사용자 메시지와 스트리밍 중인 답변 행이 복원되고, 답변은 지금까지 받은 만큼 차 있다
  expect(roles).toEqual(['user', 'assistant']);
  expect(restored.rows[0].content).toBe('안녕하세요');
  expect(LEAK.startsWith(restored.rows[1].content)).toBe(true);
  expect(restored.rows[1].content.length).toBeGreaterThan(0);
  // 작업 중 표시도 돌아온다
  const busy = events.slice(returnedAt).find((event: any) => event.type === 'busy');
  expect(busy.value).toBe(true);

  // 돌아온 뒤로는 스트리밍이 다시 화면에 흐른다
  const liveAfterReturn = events
    .slice(returnedAt)
    .filter((event: any) => event.type === 'row:update');
  await turn;
  const liveAll = events.slice(returnedAt).filter((event: any) => event.type === 'row:update');
  expect(liveAll.length).toBeGreaterThan(liveAfterReturn.length);
  expect(liveAll.at(-1).content).toBe(LEAK);
});

test('턴 도중 다른 프로젝트의 대화로도 옮길 수 있고, 이전 턴은 원래 프로젝트에 기록된다', async () => {
  slowProvider();
  const { controller, events, originalId, storage, viewingId } = await setup();
  const { mkdtempSync } = await import('node:fs');
  const startCwd = process.cwd();
  const otherProject = mkdtempSync(join(tmpdir(), 'newbie-switch-project-'));
  const elsewhere = {
    ...storage.createSessionPersistence(otherProject),
    mock: false,
    mode: 'agent',
  } as any;
  storage.recordSessionMessages(elsewhere, [{ role: 'user', content: '다른 프로젝트' }]);

  try {
    const turn = controller.submit('안녕하세요');
    await new Promise(resolve => setTimeout(resolve, 40));
    controller.resumeSession(elsewhere.sessionId);
    await turn;

    // 예전엔 "끝난 뒤에 옮길 수 있다"는 알림만 띄우고 제자리였다
    expect(viewingId()).toBe(elsewhere.sessionId);
    expect(process.cwd().toLowerCase()).toBe(otherProject.toLowerCase());
    expect(
      events.some(
        (event: any) => event.type === 'notice' && String(event.text).includes('끝난 뒤'),
      ),
    ).toBe(false);
    // 이전 턴은 전역 cwd가 바뀐 뒤에도 원래 프로젝트의 파일에 끝까지 기록됐다
    const original = storage.loadSessionById(originalId, startCwd);
    expect(original.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(original.messages[1].content).toBe(LEAK);
  } finally {
    process.chdir(startCwd);
    try {
      rmSync(otherProject, { force: true, recursive: true });
    } catch {
      // Windows에서 잠겨 있으면 포기
    }
  }
});

// 사이드바 프로젝트 그룹의 +. 다른 대화의 턴이 도는 중이어도 그 폴더에서 새 대화를 연다
test('턴 도중 다른 폴더에서 새 대화를 열 수 있고, 이전 턴은 원래 프로젝트에 기록된다', async () => {
  slowProvider();
  const { controller, events, originalId, storage, viewingId } = await setup();
  const { mkdtempSync } = await import('node:fs');
  const startCwd = process.cwd();
  const otherProject = mkdtempSync(join(tmpdir(), 'newbie-new-in-project-'));

  try {
    const turn = controller.submit('안녕하세요');
    await new Promise(resolve => setTimeout(resolve, 40));
    const id = controller.newSessionIn(otherProject);
    await turn;

    expect(id).not.toBe(originalId);
    expect(viewingId()).toBe(id);
    expect(process.cwd().toLowerCase()).toBe(otherProject.toLowerCase());
    expect(
      events.some(
        (event: any) => event.type === 'notice' && String(event.text).includes('끝난 뒤'),
      ),
    ).toBe(false);
    const original = storage.loadSessionById(originalId, startCwd);
    expect(original.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  } finally {
    process.chdir(startCwd);
    try {
      rmSync(otherProject, { force: true, recursive: true });
    } catch {
      // Windows에서 잠겨 있으면 포기
    }
  }
});
