// 보조 에이전트(spawn_agent) 회귀 테스트.
//
// 프로바이더만 갈아끼우고 루프·도구·저장은 제품 코드 그대로 돌린다. 고정하는 것:
//   1. 보고를 받을 곳이 없으면(CLI) 부모가 spawn_agent를 부를 때 자식 루프가 돌고, 자식의 최종 글이 부모의
//      도구 결과로 돌아온다. 자식이 실행한 도구 호출은 children으로 남는다.
//   2. 자식 안의 도구 이벤트는 parentId를 달고 부모의 onToolEvent로 나간다.
//   3. 탐색 자식은 읽기 도구만 받고, 어떤 자식도 spawn_agent를 다시 부를 수 없다.
//   4. children은 세션 파일을 거쳐도 중첩 행으로 되살아난다.
//   5. 보고를 받을 곳(onAgentReport)이 있으면 자식은 백그라운드로 돌고, 도구는 바로
//      돌아온다. 보고는 훅으로 나가고, 자동 알림에 실려 저장된 보고는 다시 열 때
//      그 행에 붙는다.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, mock, test } from 'bun:test';

const HOME = join(tmpdir(), `newbie-subagent-test-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

// 이 파일이 갈아끼운 프로바이더 목은 같은 프로세스에서 도는 다른 테스트 파일에도
// 그대로 남는다. 실제로 진짜 프로바이더로 로컬 서버를 부르는 distillCheckpoint가
// 빈 응답을 받아 깨졌다. 끝나면 원본으로 되돌린다
const realProviders = { ...(await import('../src/providers/index.ts')) };
afterAll(() => {
  mock.module('../src/providers/index.ts', () => realProviders);
});

const work = mkdtempSync(join(tmpdir(), 'newbie-subagent-work-'));
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

type Call = { messages: any[]; systemPrompt: string; tools: string[] };

/**
 * 부모와 자식을 한 프로바이더로 받는다. 자식 호출은 시스템 프롬프트로 구분한다
 * (자식 프롬프트는 "subagent of"로 시작한다). 각 역할은 라운드 순서대로 대본을 탄다
 */
function scriptProvider(script: { child: any[]; parent: any[] }) {
  const state = { calls: [] as Call[], childCalls: 0, parentCalls: 0 };
  mock.module('../src/providers/index.ts', () => ({
    // 루프가 이름으로 가져오므로 없으면 이 파일만 단독으로 돌릴 때 import가 깨진다
    countProviderTokens: async () => null,
    runProviderText: async () => '',
    runProviderTurn: async (session: any, context: any) => {
      const systemPrompt = String(context.systemPrompt ?? '');
      const tools = (context.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name);
      state.calls.push({ messages: session.messages, systemPrompt, tools });
      const child = systemPrompt.includes('You are a subagent of');
      const responses = child ? script.child : script.parent;
      const index = child ? state.childCalls++ : state.parentCalls++;
      const resp = responses[Math.min(index, responses.length - 1)];
      if (resp.text) context.output.write(resp.text);
      return { usage: undefined, ...resp };
    },
  }));
  return state;
}

function session(mode: 'agent' | 'chat' = 'agent') {
  return {
    initialRows: [],
    messages: [],
    mock: false,
    mode,
    model: 'gpt-5.5',
    permissionMode: 'auto',
    projectPath: work,
    provider: 'openai',
    sessionId: 'parent-session',
    sessionPath: join(HOME, 'nowhere.jsonl'),
  } as any;
}

const spawn = (id: string, type?: string) => ({
  text: '',
  toolCalls: [
    {
      id,
      input: {
        description: '메모 파일 확인',
        prompt: `${target} 파일을 읽고 내용을 한 줄로 보고하세요.`,
        ...(type ? { type } : {}),
      },
      name: 'spawn_agent',
    },
  ],
});
const say = (text: string) => ({ text, toolCalls: [] });

test('자식 루프의 보고가 부모의 도구 결과가 되고, 자식의 도구 호출은 children으로 남는다', async () => {
  const state = scriptProvider({
    parent: [spawn('call-agent-1'), say('보고 받았습니다.')],
    child: [
      { text: '', toolCalls: [{ id: 'child-read-1', input: { path: target }, name: 'read_file' }] },
      say('note.txt에는 "hello from note"가 있습니다.'),
    ],
  });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const events: any[] = [];
  const result = await runAgentLoop(session(), {
    onToolEvent: event => events.push(event),
    output: { write: () => {} },
  });

  expect(result.text).toBe('보고 받았습니다.');
  // 부모 이력: spawn_agent 한 건, 결과는 자식의 최종 글, children에 자식의 read_file
  const agentTurn = result.toolTurns.find(turn => turn.toolCalls?.length);
  const call = agentTurn!.toolCalls![0];
  expect(call.name).toBe('spawn_agent');
  expect(call.ok).toBe(true);
  expect(call.result).toBe('note.txt에는 "hello from note"가 있습니다.');
  expect(call.children?.map(child => child.name)).toEqual(['read_file']);
  expect(call.children?.[0].result).toContain('hello from note');

  // 자식 안의 이벤트는 parentId를 달고 나온다
  const childEvents = events.filter(event => event.parentId);
  expect(childEvents.map(event => [event.name, event.parentId, event.phase])).toEqual([
    ['read_file', 'call-agent-1', 'start'],
    ['read_file', 'call-agent-1', 'done'],
  ]);
  expect(events.filter(event => event.name === 'spawn_agent' && !event.parentId)).toHaveLength(2);

  // 부모는 spawn_agent를 받고, 탐색 자식은 읽기 도구만 받는다
  const parentCall = state.calls[0];
  expect(parentCall.tools).toContain('spawn_agent');
  const childCall = state.calls.find(entry => entry.systemPrompt.includes('You are a subagent of'))!;
  expect(childCall.tools).toContain('read_file');
  expect(childCall.tools).toContain('search_files');
  expect(childCall.tools).not.toContain('create_file');
  expect(childCall.tools).not.toContain('run_command');
  expect(childCall.tools).not.toContain('spawn_agent');
  // 도구 설명은 정의(JSON)로만 나간다. 안내에는 허용된 지연 내장 도구의 시그니처만 남는다
  expect(childCall.systemPrompt).not.toContain('read_file(');
  expect(childCall.systemPrompt).toContain('get_file_info(path)');
  expect(childCall.systemPrompt).not.toContain('delete_file(');
  expect(childCall.systemPrompt).not.toContain('spawn_agent(');
  expect(childCall.systemPrompt).toContain('read-only');
  // 자식의 첫 메시지는 부모가 준 지시 그대로
  expect(childCall.messages[0].content).toContain('한 줄로 보고하세요');
});

test('일반 자식은 수정 도구를 받지만 spawn_agent는 다시 부를 수 없다', async () => {
  const state = scriptProvider({
    parent: [spawn('call-agent-2', 'general'), say('끝')],
    child: [
      // 자식이 금지된 도구를 지어내 부른다 → 실행 없이 거절 결과
      { text: '', toolCalls: [{ id: 'child-spawn', input: { description: 'x', prompt: 'y' }, name: 'spawn_agent' }] },
      say('보고'),
    ],
  });
  const { runAgentLoop } = await import('../src/agent/loop.ts');
  const result = await runAgentLoop(session(), { output: { write: () => {} } });

  const call = result.toolTurns.find(turn => turn.toolCalls?.length)!.toolCalls![0];
  expect(call.result).toBe('보고');
  expect(call.children).toHaveLength(1);
  expect(call.children![0].ok).toBe(false);
  expect(call.children![0].result).toContain('쓸 수 없습니다');

  const childCall = state.calls.find(entry => entry.systemPrompt.includes('You are a subagent of'))!;
  expect(childCall.tools).toContain('edit_file');
  expect(childCall.tools).toContain('run_command');
  expect(childCall.tools).not.toContain('spawn_agent');
  expect(childCall.systemPrompt).toContain('Making changes');
});

test('채팅 모드에는 spawn_agent가 없다', async () => {
  const state = scriptProvider({ parent: [say('안녕')], child: [] });
  const { runAgentLoop } = await import('../src/agent/loop.ts');
  await runAgentLoop(session('chat'), { output: { write: () => {} } });
  expect(state.calls[0].tools).not.toContain('spawn_agent');
});

test('children은 세션 파일을 거쳐도 부모 행 아래 중첩 행으로 되살아난다', async () => {
  const storage = await import('../src/session/storage.ts');
  const persisted = { ...storage.createSessionPersistence(work), mock: false, mode: 'agent' } as any;
  storage.recordSessionMessages(persisted, [
    { content: '조사해줘', role: 'user' },
    {
      content: '',
      role: 'assistant',
      toolCalls: [
        {
          children: [
            { id: 'c1', input: { path: 'a.ts' }, name: 'read_file', ok: true, result: 'A' },
            { id: 'c2', input: { glob: '*.ts' }, name: 'search_files', ok: false, result: '오류' },
          ],
          id: 'p1',
          input: { description: '구조 파악', prompt: '...', type: 'explore' },
          name: 'spawn_agent',
          ok: true,
          result: '보고서',
        },
      ],
    },
    { content: '끝', role: 'assistant' },
  ]);

  const loaded = storage.loadSessionById(persisted.sessionId, work);
  const tools = loaded.rows.filter(row => row.role === 'tool');
  expect(tools.map(row => [row.id, row.parentId ?? null, row.toolStatus])).toEqual([
    ['tool-p1', null, 'done'],
    ['tool-c1', 'tool-p1', 'done'],
    ['tool-c2', 'tool-p1', 'error'],
  ]);
  expect(tools[0].content).toBe('구조 파악');
  expect(tools[0].target).toBe('탐색');
  // 모델 이력에도 children이 남아 있다 (화면 복원용). 프로바이더로는 나가지 않는다
  const { expandToolHistory } = await import('../src/providers/toolHistory.ts');
  const call = loaded.messages[1].toolCalls![0];
  expect(call.children).toHaveLength(2);
  expect(JSON.stringify(expandToolHistory(loaded.messages, 'openai'))).not.toContain('children');
});

test('보고를 받을 곳이 있으면 spawn_agent는 바로 돌아오고, 보고는 onAgentReport로 나간다', async () => {
  scriptProvider({
    parent: [spawn('call-agent-bg'), say('보고를 기다립니다.')],
    child: [
      { text: '', toolCalls: [{ id: 'child-read-bg', input: { path: target }, name: 'read_file' }] },
      say('note.txt에는 "hello from note"가 있습니다.'),
    ],
  });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const started: any[] = [];
  const events: any[] = [];
  let resolveReport!: (report: any) => void;
  const reported = new Promise<any>(resolve => {
    resolveReport = resolve;
  });
  const result = await runAgentLoop(session(), {
    onAgentReport: report => resolveReport(report),
    onAgentStart: agent => started.push(agent),
    onToolEvent: event => events.push(event),
    output: { write: () => {} },
  });

  // 부모의 도구 결과는 "시작했다"뿐이고, 자식 호출은 아직 없다
  expect(result.text).toBe('보고를 기다립니다.');
  const call = result.toolTurns.find(turn => turn.toolCalls?.length)!.toolCalls![0];
  expect(call.result).toContain('백그라운드로 시작');
  expect(call.children).toBeUndefined();
  // 완료 이벤트는 background 표식을 달고 나간다 — 화면은 행을 running으로 둔다
  const done = events.find(event => event.name === 'spawn_agent' && event.phase === 'done');
  expect(done.background).toBe(true);
  expect(started.map(agent => agent.callId)).toEqual(['call-agent-bg']);

  // 보고는 훅으로 따로 온다
  const report = await reported;
  expect(report).toMatchObject({
    aborted: false,
    callId: 'call-agent-bg',
    description: '메모 파일 확인',
    ok: true,
  });
  expect(report.text).toContain('hello from note');
  expect(report.children.map((child: any) => child.name)).toEqual(['read_file']);
});

test('백그라운드 자식을 중단하면 보고는 aborted로 표시된다', async () => {
  scriptProvider({
    parent: [spawn('call-agent-stop'), say('끝')],
    child: [
      { text: '', toolCalls: [{ id: 'child-read-stop', input: { path: target }, name: 'read_file' }] },
      say('보고'),
    ],
  });
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  let resolveReport!: (report: any) => void;
  const reported = new Promise<any>(resolve => {
    resolveReport = resolve;
  });
  await runAgentLoop(session(), {
    onAgentReport: report => resolveReport(report),
    // 컨트롤러가 Esc로 끊는 것과 같은 경로
    onAgentStart: agent => agent.abort.abort(),
    output: { write: () => {} },
  });

  const report = await reported;
  expect(report.aborted).toBe(true);
  expect(report.text).toContain('중단');
});

test('자동 알림에 실린 보고는 다시 열 때 spawn_agent 행에 붙고, 사용자 말풍선이나 요청 목록이 되지 않는다', async () => {
  const storage = await import('../src/session/storage.ts');
  const persisted = { ...storage.createSessionPersistence(work), mock: false, mode: 'agent' } as any;
  const notice = '[자동 알림 — 사용자가 보낸 메시지가 아닙니다] 보조 에이전트 "구조 파악"이(가) 끝났습니다. 보고:\n\n보고서';
  storage.recordSessionMessages(persisted, [
    { content: '조사해줘', role: 'user' },
    {
      content: '',
      role: 'assistant',
      toolCalls: [
        {
          id: 'p2',
          input: { description: '구조 파악', prompt: '...' },
          name: 'spawn_agent',
          ok: true,
          result: '백그라운드로 시작했습니다.',
        },
      ],
    },
    { content: '기다립니다.', role: 'assistant' },
    {
      agentReport: {
        callId: 'p2',
        children: [{ id: 'c3', input: { path: 'a.ts' }, name: 'read_file', ok: true, result: 'A' }],
        ok: true,
        text: '보고서',
      },
      automatic: true,
      content: notice,
      role: 'user',
    },
    { content: '끝', role: 'assistant' },
  ]);

  const loaded = storage.loadSessionById(persisted.sessionId, work);
  // 화면: 자동 알림은 말풍선이 없고, 보고가 spawn_agent 행에 붙고 자식 행이 중첩된다
  expect(loaded.rows.filter(row => row.role === 'user').map(row => row.content)).toEqual(['조사해줘']);
  const tools = loaded.rows.filter(row => row.role === 'tool');
  expect(tools.map(row => [row.id, row.parentId ?? null, row.toolStatus])).toEqual([
    ['tool-p2', null, 'done'],
    ['tool-c3', 'tool-p2', 'done'],
  ]);
  expect(tools[0].result).toBe('보고서');

  // 모델 이력: 표식은 남되 프로바이더로는 나가지 않고, 끼어듦 마커도 붙지 않는다
  const automatic = loaded.messages[3];
  expect(automatic.automatic).toBe(true);
  expect(automatic.agentReport?.callId).toBe('p2');
  const { expandToolHistory } = await import('../src/providers/toolHistory.ts');
  const expanded = expandToolHistory(loaded.messages, 'openai') as any[];
  const sent = expanded.find(message => message.role === 'user' && String(message.content).startsWith('[자동 알림'));
  expect(sent.content).toBe(notice);
  expect(Object.keys(sent).sort()).toEqual(['content', 'role']);

  // 압축: 사용자 요청 목록에도, 턴 경계에도 들어가지 않는다
  const { collectUserPrompts, splitForCompaction } = await import('../src/agent/compact.ts');
  expect(collectUserPrompts(loaded.messages)).toEqual(['조사해줘']);
  expect(splitForCompaction(loaded.messages, 1).older).toEqual([]);
});
