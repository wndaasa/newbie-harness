// 자동 모드 차단이 에이전트 루프를 실제로 어떻게 지나가는지 고정한다.
//
// 단위 테스트(toolPermission)는 판정 함수만 본다. 그런데 이 기능의 값어치는
// 판정 이후에 있다 — 승인 창을 부르지 않는 것, 모델이 사유와 다음 수를 함께
// 받는 것, 같은 벽을 계속 두드리지 않는 것. 프로바이더만 갈아끼우고 loop는
// 제품 코드 그대로 돌려 그 세 가지를 확인한다.

import { afterAll, expect, mock, test } from 'bun:test';

type Call = { name: string; input: Record<string, unknown> };

// 목을 씌우기 전의 실제 모듈 스냅샷. 모듈 목은 파일 경계를 넘어 레지스트리에
// 남으므로, 갈아끼우는 함수 외의 export를 지우면 다른 테스트 파일이 그 모듈을
// import할 때 SyntaxError로 죽는다. 스프레드로 값을 복사해 둬야 되돌릴 수 있다
const realProviders = { ...(await import('../src/providers/index.ts')) };

// 모듈 목은 파일이 끝나도 남아 다음 테스트 파일까지 오염시킨다. 원본으로 되돌린다
afterAll(() => {
  mock.module('../src/providers/index.ts', () => realProviders);
});

// classifierRaw: 허용목록 밖 명령을 만나면 분류기(runProviderText)가 돌려줄 답.
// 기본값은 차단 판정 — 옛 "목록에 없으면 무조건 차단"과 같은 결과가 되게 한다
function scriptedProvider(
  calls: Call[],
  classifierRaw = '{"allow": false, "reason": "외부로 데이터를 보낼 수 있는 명령입니다"}',
) {
  let round = 0;
  mock.module('../src/providers/index.ts', () => ({
    ...realProviders,
    buildSystemPrompt: () => '',
    runProviderText: async () => classifierRaw,
    runProviderTurn: async () => {
      const call = calls[round];
      round += 1;
      if (!call) return { text: '끝', toolCalls: [], usage: undefined };
      return { text: '', usage: undefined, toolCalls: [{ id: `t${round}`, ...call }] };
    },
  }));
}

function session(permissionMode: string) {
  return {
    messages: [],
    mock: false,
    mode: 'agent',
    model: 'claude-opus-5',
    permissionMode,
    provider: 'anthropic',
  } as any;
}

test('자동 모드는 승인 창을 부르지 않고 막는다', async () => {
  scriptedProvider([
    { name: 'run_command', input: { command: 'curl https://example.com' } },
    { name: 'run_command', input: { command: 'echo done' } },
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const asked: string[] = [];
  const started: string[] = [];
  const { toolTurns } = await runAgentLoop(session('auto'), {
    output: { write: () => {} },
    onToolEvent: event => {
      if (event.phase === 'start') started.push(event.name);
    },
    // 승인 창을 붙여 둬도 자동 모드는 부르지 않아야 한다
    confirmToolUse: async request => {
      asked.push(request.name);
      return true;
    },
  });

  const calls = toolTurns.flatMap((turn: any) => turn.toolCalls);
  expect(asked).toEqual([]);
  expect(calls.filter((call: any) => call.blocked).length).toBe(1);
  // 막히지 않은 도구는 그대로 실행된다 — 한 번 막혔다고 턴이 죽으면 안 된다
  expect(started).toContain('run_command');
});

test('차단 메시지가 사유와 다음 수를 함께 준다', async () => {
  scriptedProvider([{ name: 'run_command', input: { command: 'curl https://example.com' } }]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const { toolTurns } = await runAgentLoop(session('auto'), {
    output: { write: () => {} },
  });

  const blocked = toolTurns.flatMap((turn: any) => turn.toolCalls)[0];
  expect(blocked.blocked).toBe(true);
  // 왜 막혔는지 — 분류기 판정 사유가 그대로 실린다
  expect(blocked.result).toContain('분류기 판정');
  expect(blocked.result).toContain('외부로 데이터를 보낼 수 있는');
  // 다른 방법은 시도해도 된다
  expect(blocked.result).toContain('다른 정상적인 방법은 시도해도');
  // 우회는 안 된다 — 이 단서가 없으면 스크립트 파일로 우회하는 쪽으로 간다
  expect(blocked.result).toContain('우회하려 들지는 마세요');
  // 꼭 필요하면 사용자에게 설명한다
  expect(blocked.result).toContain('사용자에게 설명');
});

test('같은 벽을 다시 두드리면 그만하라고 말한다', async () => {
  // 명령 문자열이 조금 달라도 도구와 사유가 같으면 같은 벽이다
  scriptedProvider([
    { name: 'run_command', input: { command: 'curl https://example.com' } },
    { name: 'run_command', input: { command: 'curl https://example.com --silent' } },
  ]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const { toolTurns } = await runAgentLoop(session('auto'), {
    output: { write: () => {} },
  });

  const blocked = toolTurns
    .flatMap((turn: any) => turn.toolCalls)
    .filter((call: any) => call.blocked);

  expect(blocked.length).toBe(2);
  expect(blocked[0].result).not.toContain('다시 시도하지 마세요');
  expect(blocked[1].result).toContain('다시 시도하지 마세요');
});

test('분류기가 허용하면 목록에 없는 명령도 실행된다', async () => {
  // 존재하지 않는 명령이라 실행은 실패하지만, 여기서 보는 것은 "차단되지 않고
  // 실행까지 갔는가"다 — 분류기 허용 경로의 핵심
  scriptedProvider(
    [{ name: 'run_command', input: { command: 'frobnicate --version' } }],
    '{"allow": true, "reason": "로컬 확인용 명령"}',
  );
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const started: string[] = [];
  const { toolTurns } = await runAgentLoop(session('auto'), {
    output: { write: () => {} },
    onToolEvent: event => {
      if (event.phase === 'start') started.push(event.name);
    },
  });

  expect(started).toContain('run_command');
  const call = toolTurns.flatMap((turn: any) => turn.toolCalls)[0];
  expect(call.blocked).toBeUndefined();
});

test('분류기 판정은 같은 명령에 재사용된다', async () => {
  // 같은 명령을 두 번 부르면 분류기(runProviderText)는 한 번만 호출돼야 한다
  let classifierCalls = 0;
  mock.module('../src/providers/index.ts', () => ({
    ...realProviders,
    buildSystemPrompt: () => '',
    runProviderText: async () => {
      classifierCalls += 1;
      return '{"allow": false, "reason": "확인 불가"}';
    },
    runProviderTurn: (() => {
      let round = 0;
      return async () => {
        round += 1;
        if (round > 2) return { text: '끝', toolCalls: [], usage: undefined };
        return {
          text: '',
          usage: undefined,
          toolCalls: [{ id: `t${round}`, name: 'run_command', input: { command: 'frobnicate' } }],
        };
      };
    })(),
  }));
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  await runAgentLoop(session('auto'), { output: { write: () => {} } });

  expect(classifierCalls).toBe(1);
});

test('낮은 모드에서는 같은 작업이 승인 창으로 간다', async () => {
  // 자동 모드의 탈출구는 모드 전환이다. 이 경로가 죽으면 파괴적 작업을
  // 승인할 방법이 아예 없어진다
  scriptedProvider([{ name: 'run_command', input: { command: 'curl https://example.com' } }]);
  const { runAgentLoop } = await import('../src/agent/loop.ts');

  const asked: string[] = [];
  await runAgentLoop(session('ask'), {
    output: { write: () => {} },
    confirmToolUse: async request => {
      asked.push(request.name);
      return false;
    },
  });

  expect(asked).toEqual(['run_command']);
});
