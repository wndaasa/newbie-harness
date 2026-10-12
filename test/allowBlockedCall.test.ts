// 막힌 도구 행의 "이 명령 허용" 회귀 테스트 (컨트롤러).
//
// 자동 모드의 분류기는 사용자가 대화로 동의해도 차단 목록을 풀지 않는다. 사용자가 막힌
// 행에서 직접 허용하면, 그 행의 명령만 정확히 같은 문자열로 허용 목록에 넣고 모델에게
// 그대로 다시 실행하라고 보내는지 고정한다. 화면은 행 id만 보내므로, 기록에 없는 id나
// 이미 쓴 id로는 아무것도 허용되지 않아야 한다.

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { afterAll, expect, mock, test } from 'bun:test';

const HOME = join(tmpdir(), `newbie-allow-test-${process.pid}`);
process.env.NEWBIE_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const realProviders = { ...(await import('../src/providers/index.ts')) };

afterAll(() => {
  mock.module('../src/providers/index.ts', () => realProviders);
  try {
    rmSync(HOME, { force: true, recursive: true });
  } catch {
    // Windows에서 파일이 잠겨 있으면 임시 폴더 청소는 포기해도 된다
  }
});

const COMMAND = 'python migrate.py';
const seen: { content?: unknown; role: string }[][] = [];
let classified = 0;

mock.module('../src/providers/index.ts', () => ({
  ...realProviders,
  runProviderText: async (_session: unknown, options: { systemPrompt?: string }) => {
    if (options.systemPrompt?.includes('safety classifier')) {
      classified += 1;
      return '{"allow": false, "reason": "운영 데이터베이스 구조 변경"}';
    }
    return ''; // 제목 생성은 빈 값 → 건너뜀
  },
  runProviderTurn: async (session: { messages: { content?: unknown; role: string }[] }) => {
    seen.push(session.messages);
    if (seen.length === 1) {
      return { text: '', toolCalls: [{ id: 't1', input: { command: COMMAND }, name: 'run_command' }], usage: undefined };
    }
    // 실제로 명령을 다시 돌리지는 않는다. 허용 목록이 판정을 건너뛰는 것은 루프 테스트가 본다
    return { text: '알겠습니다.', toolCalls: [], usage: undefined };
  },
}));

test('막힌 행에서 허용하면 그 명령만 허용 목록에 넣고, 그대로 다시 실행하라고 보낸다', async () => {
  const { createController } = await import('../app/main/controller.ts');
  const { createSession } = await import('../src/config.ts');
  const session = createSession({});
  session.permissionMode = 'auto';
  const events: any[] = [];
  const controller = createController({ emit: (event: unknown) => events.push(event), quit: () => {}, session });

  await controller.submit('검색 서버용 MView를 만들어 줘');

  // 분류기가 막았고, 그 행에 버튼을 붙일 수 있다고 표시됐다
  expect(classified).toBe(1);
  const row = events.find(event => event.type === 'row:append' && event.row?.toolStatus === 'blocked')?.row;
  expect(row?.id).toBe('tool-t1');
  expect(row?.allowable).toBe(true);

  // 기록에 없는 행 id로는 아무것도 허용되지 않는다
  await controller.allowBlockedCall('tool-made-up');
  expect(session.approvedCommands ?? []).toEqual([]);
  expect(seen.length).toBe(2);

  await controller.allowBlockedCall('tool-t1');

  expect(session.approvedCommands).toEqual([COMMAND]);
  expect(events.some(event => event.type === 'row:patch' && event.id === 'tool-t1' && event.patch?.allowed)).toBe(true);
  // 끝난 턴이라 새 턴으로 보냈고, 모델은 무엇을 그대로 다시 실행할지 받는다
  expect(seen.length).toBe(3);
  // 맨 끝의 user 메시지는 앱이 매 턴 붙이는 환경 정보라 뺀다
  const followUp = String(
    seen[2]
      .filter(message => message.role === 'user' && !String(message.content).startsWith('[환경 정보'))
      .at(-1)?.content ?? '',
  );
  expect(followUp).toContain('그대로 다시 실행해 주세요');
  expect(followUp).toContain(COMMAND);

  // 같은 행을 다시 눌러도 두 번 보내지 않는다
  await controller.allowBlockedCall('tool-t1');
  expect(seen.length).toBe(3);
});
