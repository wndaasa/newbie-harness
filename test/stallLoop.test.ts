// 정체(stall) 안전장치가 에이전트 루프를 실제로 어떻게 지나가는지 고정한다.
//
// 프로바이더만 갈아끼우고 loop는 제품 코드 그대로 돌려 두 가지를 확인한다.
//   1. 도구가 실패했는데 후속 조치 없이 끝낸 응답이 오면 그냥 멈추지 않고
//      이어서 돌리는지 — 그리고 무한히 재촉하지는 않는지.
//   2. 재촉으로 폐기되는 라운드의 텍스트가 화면(output)에 한 글자도 나가지
//      않는지. 화면에 나간 토큰은 어떤 경우에도 지우지 않는다는 원칙이라,
//      폐기될 수 있는 텍스트는 애초에 내보내지 않아야 한다.

import { afterAll, expect, mock, test } from 'bun:test';

// 이 파일이 갈아끼운 프로바이더 목은 같은 프로세스에서 도는 다른 테스트 파일에도
// 그대로 남는다. 실제로 진짜 프로바이더로 로컬 서버를 부르는 distillCheckpoint가
// 빈 응답을 받아 깨졌다. 끝나면 원본으로 되돌린다
const realProviders = { ...(await import('../src/providers/index.ts')) };
afterAll(() => {
  mock.module('../src/providers/index.ts', () => realProviders);
});

type Resp = { reasoning?: string; text: string; toolCalls: any[]; usage: undefined };

// 라운드마다 미리 정해둔 응답을 돌려주는 가짜 프로바이더. 호출 횟수를 세고,
// 루프가 밀어넣는 메시지(재촉 등)를 검사할 수 있게 마지막 이력도 남긴다
function scriptProvider(responses: Resp[]) {
  const state = { calls: 0, lastMessages: [] as any[] };
  mock.module('../src/providers/index.ts', () => ({
    buildSystemPrompt: () => '',
    // 분류기(commandClassifier)가 같은 모듈에서 가져오는 export. 없으면 이 파일을
    // 단독으로 돌릴 때 loop import 자체가 깨진다
    runProviderText: async () => '',
    runProviderTurn: async (session: any, context: any) => {
      const resp = responses[Math.min(state.calls, responses.length - 1)];
      state.calls += 1;
      state.lastMessages = session.messages;
      // 실제 프로바이더처럼 추론 요약 → 텍스트 순으로 output에 스트리밍한다
      if (resp.reasoning) context.output.writeReasoning?.(resp.reasoning);
      if (resp.text) context.output.write(resp.text);
      return resp;
    },
  }));
  return state;
}

function session(mode: 'agent' | 'chat' = 'agent') {
  return {
    messages: [],
    mock: false,
    mode,
    model: 'claude-opus-5',
    permissionMode: 'auto',
    provider: 'anthropic',
  } as any;
}

const silence = (text: string): Resp => ({ text, toolCalls: [], usage: undefined });
// 없는 파일을 읽어 도구가 실패한다 (read 계열이라 자동 모드에서 실행은 됨)
const failingTool = (): Resp => ({
  text: '',
  toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'C:/__no_such_file__.md' } }],
  usage: undefined,
});

test('도구가 실패한 뒤 손을 놓으면 재촉해 이어서 돌린다', async () => {
  const state = scriptProvider([
    failingTool(),
    silence('파일이 없어서 못 읽었습니다.'), // 실패 뒤 침묵 → 재촉
    silence('완료했습니다.'),
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const started: string[] = [];
  const { text } = await runAgentLoop(session(), {
    output: { write: () => {} },
    onToolEvent: event => {
      if (event.phase === 'start') started.push(event.name);
    },
  });

  expect(started).toContain('read_file');
  expect(state.calls).toBe(3); // 실패 라운드 → 재촉 → 완료
  expect(text).toBe('완료했습니다.');
});

test('재촉 메시지는 자동 알림 표식과 실패 도구 이름을 담는다', async () => {
  const state = scriptProvider([
    failingTool(),
    silence('파일이 없어서 못 읽었습니다.'),
    silence('완료했습니다.'),
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  await runAgentLoop(session(), { output: { write: () => {} } });

  // 마지막 프로바이더 호출이 받은 이력에 재촉이 user 역할로 들어 있어야 한다
  const nudge = state.lastMessages.filter((m: any) => m.role === 'user').at(-1);
  expect(nudge.content).toContain('[자동 알림');
  expect(nudge.content).toContain('`read_file`');
});

test('폐기한 라운드의 텍스트는 화면에 한 글자도 나가지 않는다', async () => {
  const state = scriptProvider([
    failingTool(),
    silence('다시 시도하겠습니다.'), // 재촉으로 폐기됨 → 화면에 나가면 안 됨
    silence('완료했습니다.'),
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  let shown = '';
  await runAgentLoop(session(), { output: { write: chunk => void (shown += chunk) } });

  expect(state.calls).toBe(3);
  expect(shown).not.toContain('다시 시도하겠습니다');
  expect(shown).toContain('완료했습니다.');
});

test('실패 직후라도 되물음으로 끝나면 재촉하지 않고 그대로 내보낸다', async () => {
  const state = scriptProvider([
    failingTool(),
    silence('파일이 없습니다. 경로를 다시 알려주시겠어요?'),
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  let shown = '';
  await runAgentLoop(session(), { output: { write: chunk => void (shown += chunk) } });

  // 사용자 결정을 기다려야 하는 응답까지 밀어붙이면 안 되고, 버퍼는 방출돼야 한다
  expect(state.calls).toBe(2);
  expect(shown).toContain('경로를 다시 알려주시겠어요?');
});

test('실패가 없으면 약속형 문장이라도 그대로 종료한다', async () => {
  // 어미 정규식 기반 판정을 제거한 회귀 고정 — "하겠습니다"만으로는 재촉하지 않는다
  const state = scriptProvider([silence('이제 노션 페이지를 검색하겠습니다.')]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  let shown = '';
  await runAgentLoop(session(), { output: { write: chunk => void (shown += chunk) } });

  expect(state.calls).toBe(1);
  expect(shown).toBe('이제 노션 페이지를 검색하겠습니다.');
});

test('채팅 모드에서는 실패 뒤 침묵해도 재촉하지 않는다', async () => {
  const state = scriptProvider([
    failingTool(),
    silence('검색이 실패해서 아는 범위에서 답하면 이렇습니다.'),
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  let shown = '';
  await runAgentLoop(session('chat'), {
    output: { write: chunk => void (shown += chunk) },
  });

  expect(state.calls).toBe(2);
  expect(shown).toContain('아는 범위에서 답하면');
});

test('실패가 반복돼도 무한 재촉하지 않고 상한에서 멈춘다', async () => {
  // 실패 → 침묵 → (재촉) → 실패 → 침묵 → ... 상한(3회) 이후엔 침묵을 그대로 끝으로 받는다
  const state = scriptProvider([
    failingTool(), silence('못 하겠습니다.'),
    failingTool(), silence('못 하겠습니다.'),
    failingTool(), silence('못 하겠습니다.'),
    failingTool(), silence('못 하겠습니다.'),
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  await runAgentLoop(session(), { output: { write: () => {} } });

  // 재촉 3회까지만: 8라운드째 침묵에서 더 재촉하지 않고 종료
  expect(state.calls).toBe(8);
});

test('실패 뒤라도 실질적인 긴 답변은 정체로 보지 않고 그대로 내보낸다', async () => {
  // 선택적 조회가 거부된 뒤 모델이 그것 없이 최종 답변을 낸 경우. 이걸 폐기하면
  // 재촉 끝에 빈 턴이 된다 (실제 사례)
  const answer = `제 판단으로는 완성도 약 75~85% 정도입니다.\n\n### 잘 갖춰진 부분\n${'- 핵심 흐름이 구현돼 있습니다.\n'.repeat(40)}`;
  expect(answer.length).toBeGreaterThan(300);
  const state = scriptProvider([failingTool(), silence(answer)]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  let shown = '';
  const { text } = await runAgentLoop(session(), {
    output: { write: chunk => void (shown += chunk) },
  });

  expect(state.calls).toBe(2); // 재촉 없음
  expect(text).toBe(answer);
  expect(shown).toBe(answer);
});

test('재촉 끝에 빈 응답으로 끝나면 마지막에 폐기한 답변을 살린다', async () => {
  // 짧은 답 → 재촉 → 빈 응답. 재촉은 실패 한 건당 한 번이라 빈 응답은 그대로
  // 끝이 되는데, 그러면 사용자는 빈 턴을 본다 (실제 사례). 폐기했던 답을 되살린다
  const state = scriptProvider([
    failingTool(),
    { reasoning: 'give up', text: '파일이 없어서 못 읽었습니다.', toolCalls: [], usage: undefined },
    silence(''),
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const stream: string[] = [];
  const { reasoning, text } = await runAgentLoop(session(), {
    output: {
      write: chunk => void stream.push(`text:${chunk}`),
      writeReasoning: chunk => void stream.push(`reasoning:${chunk}`),
    },
  });

  expect(state.calls).toBe(3);
  expect(text).toBe('파일이 없어서 못 읽었습니다.');
  expect(reasoning).toBe('give up');
  expect(stream).toEqual(['reasoning:give up', 'text:파일이 없어서 못 읽었습니다.']);
});

test('턴 도중 도착한 메시지는 다음 라운드 직전에 이력에 끼어들고, 읽은 시각이 알려진다', async () => {
  const okTool = (): Resp => ({
    text: '먼저 파일을 보겠습니다.',
    toolCalls: [{ id: 't1', name: 'list_files', input: { path: '.' } }],
    usage: undefined,
  });
  const state = scriptProvider([okTool(), silence('b.ts까지 확인했습니다. 완료.')]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  // 첫 라운드가 도는 동안 도착한 것으로 가정: 첫 라운드 시작(1번째 호출) 때는
  // 비어 있고, 두 번째 라운드 시작 때 꺼내진다
  let takes = 0;
  const read: { id: string; readAt: string }[] = [];
  const { toolTurns } = await runAgentLoop(session(), {
    output: { write: () => {} },
    takeInterjections: () => {
      takes += 1;
      return takes === 2
        ? [{ at: '2026-08-21T03:00:07Z', id: 'row-7', text: '아 참고로 b.ts도 봐' }]
        : [];
    },
    onInterjectionRead: (id, readAt) => read.push({ id, readAt }),
  });

  // 두 번째 프로바이더 호출의 이력에 끼어든 메시지가 들어 있다
  const sent = state.lastMessages.map((m: any) => String(m.content ?? ''));
  expect(sent.some(content => content.includes('아 참고로 b.ts도 봐'))).toBe(true);
  // 모델에게는 "작업 중 도착" 표식이 붙어 간다
  expect(sent.some(content => content.startsWith('[작업 진행 중에'))).toBe(true);
  expect(read).toEqual([{ id: 'row-7', readAt: expect.any(String) }]);
  // 세션에 저장될 이력에는 도구 라운드 → 끼어든 메시지 순서로, 원문 그대로
  expect(toolTurns.map(turn => turn.role)).toEqual(['assistant', 'user']);
  expect(toolTurns[1]).toMatchObject({
    content: '아 참고로 b.ts도 봐',
    interjected: true,
    at: '2026-08-21T03:00:07Z',
  });
  expect(typeof toolTurns[1].readAt).toBe('string');
});

test('폐기한 라운드의 추론 요약도 화면에 나가지 않고, 살린 라운드는 요약→본문 순서를 지킨다', async () => {
  scriptProvider([
    failingTool(),
    { reasoning: 'I will just give up.', text: '못 읽었습니다.', toolCalls: [], usage: undefined }, // 폐기
    { reasoning: 'Retry with the right path.', text: '완료했습니다.', toolCalls: [], usage: undefined },
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  // 요약과 본문을 한 흐름으로 받아 순서까지 본다
  const stream: string[] = [];
  const { reasoning, text } = await runAgentLoop(session(), {
    output: {
      write: chunk => void stream.push(`text:${chunk}`),
      writeReasoning: chunk => void stream.push(`reasoning:${chunk}`),
    },
  });

  expect(stream).toEqual(['reasoning:Retry with the right path.', 'text:완료했습니다.']);
  expect(reasoning).toBe('Retry with the right path.');
  expect(text).toBe('완료했습니다.');
});

// ── 예고만 하고 끝난 라운드 ──────────────────────────────────────────────────
//
// 도구 실패가 없어도 "패치 전 마지막 확인: ~를 확인합니다."만 남기고 도구 호출 없이
// 턴을 끝내는 모델이 있다. 정체 재촉에는 안 걸리므로 사용자는 일하다 말고 혼자
// 끝난 화면을 봤다. 예고로 끝나면 한 번 더 돌리고, 보고형(과거형)은 건드리지 않는다

// 같은 경로를 두 번 읽으면 반복 호출로 막혀 실패로 잡히므로 파일을 달리한다
const okTool = (path: string): Resp => ({
  text: '',
  toolCalls: [{ id: `t-${path}`, name: 'read_file', input: { path } }],
  usage: undefined,
});

test('도구를 쓰던 턴이 다음 작업을 예고만 하고 끝나면 재촉해 이어서 돌린다', async () => {
  const state = scriptProvider([
    okTool('package.json'),
    silence('패치 전 마지막 확인: 설정 파일을 확인합니다.'), // 예고 → 재촉
    okTool('tsconfig.json'),
    silence('완료했습니다.'),
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const { text } = await runAgentLoop(session(), { output: { write: () => {} } });

  expect(state.calls).toBe(4);
  // 재촉 뒤에 도구 라운드가 하나 더 있어 마지막 user 메시지는 도구 결과다. 내용으로 찾는다
  const nudge = state.lastMessages.find(
    (m: any) => m.role === 'user' && String(m.content).includes('예고'),
  );
  expect(nudge).toBeTruthy();
  expect(nudge.content).toContain('[자동 알림');
  expect(text).toBe('완료했습니다.');
});

test('화면 확인을 사용자에게 떠넘기고 끝나면 재촉해 이어서 돌린다', async () => {
  const state = scriptProvider([
    okTool('package.json'),
    silence('포트가 열렸습니다. 접속해서 확인해 주세요.'), // 검증 떠넘김 → 재촉
    okTool('tsconfig.json'),
    silence('확인했습니다. 문제 없습니다.'),
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const { text } = await runAgentLoop(session(), { output: { write: () => {} } });

  expect(state.calls).toBe(4);
  const nudge = state.lastMessages.find(
    (m: any) => m.role === 'user' && String(m.content).includes('떠넘기'),
  );
  expect(nudge).toBeTruthy();
  expect(nudge.content).toContain('[자동 알림');
  expect(text).toBe('확인했습니다. 문제 없습니다.');
});

test('보고형(과거형)으로 끝난 응답은 재촉하지 않는다', async () => {
  const state = scriptProvider([
    okTool('package.json'),
    silence('설정 파일을 확인했습니다. 문제 없습니다.'),
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const { text } = await runAgentLoop(session(), { output: { write: () => {} } });

  expect(state.calls).toBe(2);
  expect(text).toBe('설정 파일을 확인했습니다. 문제 없습니다.');
});

test('예고 판정은 과거형과 되물음을 제외한다', async () => {
  const { announcesNextStep } = await import('../src/agent/loop.ts');
  expect(announcesNextStep('이제 CSS 파일을 작성합니다.')).toBe(true);
  expect(announcesNextStep('Now I will check the config file.')).toBe(true);
  expect(announcesNextStep('CSS 파일을 작성했습니다.')).toBe(false);
  expect(announcesNextStep('적용됐습니다.')).toBe(false);
  // 행동 어간 없는 서술은 예고가 아니다 — 걷어낸 어미만 보는 판정으로 돌아가지 않는다
  expect(announcesNextStep('별도 설정은 필요하지 않습니다.')).toBe(false);
});

test('검증 떠넘김 판정은 "확인해 주세요"류만 잡고 정당한 되물음은 그대로 둔다', async () => {
  const { punterVerificationToUser } = await import('../src/agent/loop.ts');
  expect(punterVerificationToUser('포트가 열렸습니다. 접속해서 확인해 주세요.')).toBe(true);
  expect(punterVerificationToUser('배포됐습니다. 화면을 확인해 주세요.')).toBe(true);
  expect(punterVerificationToUser('수정했습니다. 확인 부탁드립니다.')).toBe(true);
  // 파일명·경로처럼 모델이 스스로 알 수 없는 정보를 묻는 것은 정당한 되물음이다
  expect(punterVerificationToUser('어느 브랜치에 올릴까요?')).toBe(false);
  expect(punterVerificationToUser('경로를 다시 알려주시겠어요?')).toBe(false);
  expect(punterVerificationToUser('CSS 파일을 작성했습니다.')).toBe(false);
});

// ── 빈 라운드의 진단 기록 ──────────────────────────────────────────────────────

test('본문 없이 끝난 라운드는 사고 내용과 종료 사유를 세션 이력에 남긴다', async () => {
  const state = scriptProvider([
    okTool('package.json'),
    { reasoning: '여기서 막혔다', stopReason: 'length', text: '', toolCalls: [], usage: undefined } as any,
    silence('지금까지 확인한 것을 정리합니다.'), // 빈 본문 마무리 호출의 답
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const { text, toolTurns } = await runAgentLoop(session(), { output: { write: () => {} } });

  expect(state.calls).toBe(3);
  const note = toolTurns.find((m: any) => m.role === 'assistant' && m.content === '' && !m.toolCalls);
  expect(note?.reasoning).toBe('여기서 막혔다');
  expect(note?.stopReason).toBe('length');
  expect(text).toBe('지금까지 확인한 것을 정리합니다.');
});

// ── 환경 정보는 보내는 대화의 맨 끝에만 ──────────────────────────────────────
//
// 시스템 프롬프트에 두면 매 턴 바뀌는 git 상태 때문에 뒤의 이력 전체가 프로바이더
// 캐시에서 밀려나 처음부터 프리필됐다. 보내는 사본의 끝에만 붙고 세션 이력에는 없다

test('환경 정보는 프로바이더에 보내는 마지막 메시지로만 붙는다', async () => {
  const state = scriptProvider([okTool('package.json'), silence('완료했습니다.')]);
  const { ENV_CONTEXT_MARKER, runAgentLoop } = await import('../src/agent/loop.ts');

  const { toolTurns } = await runAgentLoop(session(), {
    envContext: '현재 작업 디렉터리: C:\\work',
    output: { write: () => {} },
  });

  const last = state.lastMessages.at(-1);
  expect(last.role).toBe('user');
  expect(last.content).toContain(ENV_CONTEXT_MARKER);
  expect(last.content).toContain('C:\\work');
  // 세션에 남는 이력에는 없다
  expect(JSON.stringify(toolTurns)).not.toContain('C:\\\\work');
});
