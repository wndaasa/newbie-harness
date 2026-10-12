// 백그라운드 보조 에이전트의 보고가 부모에게 닿는 경로 회귀 테스트 (컨트롤러).
//
// 프로바이더만 갈아끼우고 컨트롤러·루프·도구·저장은 제품 코드 그대로 돌린다.
// 고정하는 것:
//   1. 부모 턴이 돌고 있을 때 보고가 오면 다음 라운드에 자동 알림으로 끼어든다.
//      새 턴은 열리지 않는다.
//   2. 부모 턴이 끝난 뒤 보고가 오면 자동 턴이 열려 모델에게 넘어간다.
//   3. 어느 쪽이든 spawn_agent 행은 보고로 닫히고, 알림 행이 화면에 남으며,
//      자동 알림은 사용자 말풍선이 아니라 automatic 메시지로 저장된다.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, mock, test } from 'bun:test';

const HOME = join(tmpdir(), `newbie-bgagent-test-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

// 이 파일이 갈아끼운 프로바이더 목은 같은 프로세스에서 도는 다른 테스트 파일에도
// 그대로 남는다. 실제로 진짜 프로바이더로 로컬 서버를 부르는 distillCheckpoint가
// 빈 응답을 받아 깨졌다. 끝나면 원본으로 되돌린다
const realProviders = { ...(await import('../src/providers/index.ts')) };
afterAll(() => {
  mock.module('../src/providers/index.ts', () => realProviders);
});

const work = mkdtempSync(join(tmpdir(), 'newbie-bgagent-work-'));
const target = join(work, 'note.txt');
writeFileSync(target, 'hello from note\n');

afterAll(() => {
  for (const dir of [HOME, work]) {
    try {
      rmSync(dir, { force: true, recursive: true });
    } catch {
      // Windows에서 잠겨 있으면 임시 폴더 청소는 포기해도 된다
    }
  }
});

type Call = { messages: any[]; systemPrompt: string };
type Step = { text: string; toolCalls: any[] } | (() => Promise<{ text: string; toolCalls: any[] }>);

/**
 * 부모와 자식을 한 프로바이더로 받는다. 자식 호출은 시스템 프롬프트로 구분한다.
 * 대본 항목이 함수면 그 결과를 기다린다 — 타이밍을 테스트가 쥐기 위해서다
 */
function scriptProvider(script: { child: Step[]; parent: Step[] }) {
  const state = { calls: [] as Call[], childCalls: 0, parentCalls: 0 };
  mock.module('../src/providers/index.ts', () => ({
    countProviderTokens: async () => null,
    runProviderText: async () => '',
    runProviderTurn: async (session: any, context: any) => {
      const systemPrompt = String(context.systemPrompt ?? '');
      state.calls.push({ messages: session.messages, systemPrompt });
      const child = systemPrompt.includes('You are a subagent of');
      const steps = child ? script.child : script.parent;
      const index = child ? state.childCalls++ : state.parentCalls++;
      const step = steps[Math.min(index, steps.length - 1)];
      const resp = typeof step === 'function' ? await step() : step;
      if (resp.text) context.output.write(resp.text);
      return { usage: undefined, ...resp };
    },
  }));
  return state;
}

const spawn = (id: string) => ({
  text: '',
  toolCalls: [
    {
      id,
      input: { description: '메모 확인', prompt: `${target} 파일을 읽고 한 줄로 보고하세요.` },
      name: 'spawn_agent',
    },
  ],
});
const readNote = (id: string) => ({
  text: '',
  toolCalls: [{ id, input: { path: target }, name: 'read_file' }],
});
const say = (text: string) => ({ text, toolCalls: [] });

async function setup() {
  const { createController } = await import('../app/main/controller.ts');
  const { createSession } = await import('../src/config.ts');
  const storage = await import('../src/session/storage.ts');
  const events: any[] = [];
  // 기록과 작업 폴더를 임시 폴더로. 읽기 도구가 승인 없이 돌게 자동 모드로 둔다
  const session = Object.assign(createSession({}), storage.createSessionPersistence(work), {
    permissionMode: 'auto' as const,
  });
  const controller = createController({
    session,
    emit: event => events.push(event),
    quit: () => {},
  });
  return { controller, events, session };
}

async function until(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('기다리다 시간 초과');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const noticeRow = (event: any) =>
  event.type === 'row:append' &&
  event.row.role === 'system' &&
  String(event.row.content).startsWith('보조 에이전트 보고 도착');

test('부모 턴이 도는 중에 온 보고는 다음 라운드에 끼어들고, 새 턴을 열지 않는다', async () => {
  let resolveSeen!: () => void;
  const seen = new Promise<void>(resolve => {
    resolveSeen = resolve;
  });
  const state = scriptProvider({
    parent: [
      spawn('bg-1'),
      // 보고가 도착할 때까지 이 라운드를 붙잡아 두고, 도구를 불러 라운드를 하나 더 만든다
      async () => {
        await seen;
        return readNote('own-read');
      },
      say('보고를 반영했습니다.'),
    ],
    child: [readNote('child-read'), say('note.txt에는 hello from note가 있습니다.')],
  });
  const { controller, events, session } = await setup();
  const seenWatcher = setInterval(() => {
    if (events.some(noticeRow)) {
      clearInterval(seenWatcher);
      resolveSeen();
    }
  }, 5);

  await controller.submit('메모를 확인해줘');
  clearInterval(seenWatcher);

  // 턴은 하나뿐 — busy가 한 번 켜지고 한 번 꺼졌다
  expect(events.filter(event => event.type === 'busy').map(event => event.value)).toEqual([true, false]);
  // 마지막 라운드의 입력에 자동 알림이 들어갔고, 사용자의 요청은 그대로 앞에 있다
  const last = state.calls.filter(call => !call.systemPrompt.includes('You are a subagent of')).at(-1)!;
  const users = last.messages.filter((message: any) => message.role === 'user');
  expect(users[0].content).toBe('메모를 확인해줘');
  expect(JSON.stringify(users.filter((m: any) => !String(m.content).startsWith('[환경 정보')).at(-1).content)).toContain('[자동 알림');
  expect(JSON.stringify(users.filter((m: any) => !String(m.content).startsWith('[환경 정보')).at(-1).content)).toContain('hello from note');
  // 행: spawn_agent는 보고로 닫히고, 알림 행이 남는다
  const closed = events.find(
    event => event.type === 'row:patch' && event.id === 'tool-bg-1' && event.patch.toolStatus === 'done',
  );
  expect(closed.patch.result).toContain('hello from note');
  expect(events.some(noticeRow)).toBe(true);
  // 이력: 자동 알림은 automatic으로 남고 보고를 싣는다
  const automatic = session.messages.find((message: any) => message.automatic);
  expect(automatic?.agentReport?.callId).toBe('bg-1');
  expect(automatic?.interjected).toBeUndefined();
  expect(session.messages.at(-1)?.content).toBe('보고를 반영했습니다.');
});

test('부모 턴이 끝난 뒤 온 보고는 자동 턴을 열어 모델에게 넘긴다', async () => {
  let releaseChild!: () => void;
  const released = new Promise<void>(resolve => {
    releaseChild = resolve;
  });
  const state = scriptProvider({
    parent: [spawn('bg-2'), say('보고를 기다립니다.'), say('보고를 받았습니다.')],
    child: [
      // 부모 턴이 끝날 때까지 자식을 붙잡아 둔다
      async () => {
        await released;
        return say('note.txt에는 hello from note가 있습니다.');
      },
    ],
  });
  const { controller, events, session } = await setup();

  await controller.submit('메모를 확인해줘');
  expect(session.messages.at(-1)?.content).toBe('보고를 기다립니다.');
  expect(events.filter(event => event.type === 'busy').map(event => event.value)).toEqual([true, false]);

  releaseChild();
  await until(() => session.messages.at(-1)?.content === '보고를 받았습니다.');
  await until(() => events.filter(event => event.type === 'busy').length === 4);

  // 자동 턴이 한 번 더 돌았다
  expect(events.filter(event => event.type === 'busy').map(event => event.value)).toEqual([true, false, true, false]);
  const parentCalls = state.calls.filter(call => !call.systemPrompt.includes('You are a subagent of'));
  expect(parentCalls).toHaveLength(3);
  const users = parentCalls[2].messages.filter((message: any) => message.role === 'user');
  expect(JSON.stringify(users.filter((m: any) => !String(m.content).startsWith('[환경 정보')).at(-1).content)).toContain('[자동 알림');
  // 자동 턴의 입력은 사용자 말풍선이 아니다
  expect(events.filter(event => event.type === 'row:append' && event.row.role === 'user')).toHaveLength(1);
  expect(events.some(noticeRow)).toBe(true);
  // 이력과 파일: user(요청), assistant(spawn), assistant, user(automatic), assistant
  expect(session.messages.map((message: any) => [message.role, message.automatic ?? false])).toEqual([
    ['user', false],
    ['assistant', false],
    ['assistant', false],
    ['user', true],
    ['assistant', false],
  ]);
  const storage = await import('../src/session/storage.ts');
  const loaded = storage.loadSessionById(session.sessionId, work);
  expect(loaded.messages.map(message => message.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant']);
  expect(loaded.messages[3].automatic).toBe(true);
  const tool = loaded.rows.find(row => row.id === 'tool-bg-2')!;
  expect(tool.toolStatus).toBe('done');
  expect(tool.result).toContain('hello from note');
  expect(loaded.rows.filter(row => row.role === 'user')).toHaveLength(1);
});
