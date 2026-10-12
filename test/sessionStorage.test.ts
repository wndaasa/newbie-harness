// 세션 저장소 회귀 테스트.
//
// NEWBIE_HOME을 임시 경로로 돌려 실제 사용자 데이터(~/.newbie)와 격리한다.
// storage 모듈은 import 시점이 아니라 호출 시점에 경로를 계산하므로 이 방식이
// 통한다.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = join(tmpdir(), `newbie-test-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

const {
  applyLoadedSession,
  createSessionPersistence,
  deleteSession,
  listAllSessions,
  listSessions,
  loadSession,
  recordSessionClear,
  recordSessionCompaction,
  recordSessionConfig,
  recordSessionMessages,
  recordSessionRow,
  recordSessionUsage,
  renameSession,
} = await import('../src/session/storage.ts');

// 이전 이름 규칙(경로 해시 없음)을 그대로 재현
function legacyDirName(projectPath: string): string {
  return projectPath
    .replace(/^[A-Z]:/, m => m.toLowerCase())
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function newSession(projectPath: string) {
  return { mock: false, ...createSessionPersistence(projectPath) } as any;
}

beforeAll(() => rmSync(HOME, { recursive: true, force: true }));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe('프로젝트 디렉터리 이름', () => {
  test('구분자만 다른 두 경로가 섞이지 않는다', () => {
    // 이전 규칙은 특수문자를 -로 뭉개서 C:\a\b 와 C:\a-b 가 한 폴더를 썼다
    const sep = String.fromCharCode(92);
    const a = `C:${sep}tmp${sep}alpha${sep}beta`;
    const b = `C:${sep}tmp${sep}alpha-beta`;
    expect(legacyDirName(a)).toBe(legacyDirName(b));

    const dirOf = (p: string) =>
      createSessionPersistence(p).sessionPath.split(/[\\/]/).at(-2);
    expect(dirOf(a)).not.toBe(dirOf(b));
  });

  test('이전 이름으로 저장된 세션을 계속 찾고, 새 이름으로 옮긴다', () => {
    const projectPath = join(HOME, 'proj-migrate');
    const legacyDir = join(HOME, 'sessions', legacyDirName(projectPath));
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'sess-old.jsonl'),
      JSON.stringify({
        uuid: 'u1',
        sessionId: 'sess-old',
        timestamp: new Date().toISOString(),
        type: 'message',
        role: 'user',
        content: '이전 대화',
        cwd: projectPath,
        parentUuid: null,
      }) + '\n',
      'utf8',
    );

    const found = listSessions(projectPath);
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe('sess-old');
    expect(existsSync(legacyDir)).toBe(false);
  });
});

describe('첨부 이미지', () => {
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  test('본문이 아니라 파일로 저장되고 그대로 복원된다', () => {
    const projectPath = join(HOME, 'proj-image');
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      { role: 'user', content: '이거 봐줘', images: [PNG] },
      { role: 'assistant', content: '확인했습니다.' },
    ]);

    // transcript에 base64가 들어가면 세션 목록을 훑을 때마다 그만큼을 파싱한다
    const raw = readFileSync(session.sessionPath, 'utf8');
    expect(raw).not.toContain('iVBORw0KGgo');
    expect(raw).toContain('imageRefs');

    const loaded = loadSession(session.sessionId, projectPath);
    const userMessage = loaded.messages.find(m => m.role === 'user');
    expect(userMessage?.images).toEqual([PNG]);
    expect(loaded.rows.find(r => r.role === 'user')?.images).toEqual([PNG]);
  });

  test('예전 형식(본문에 박힌 data URL)도 계속 읽는다', () => {
    const projectPath = join(HOME, 'proj-legacy-image');
    const session = newSession(projectPath);
    // 형식 전환 이전에 기록된 세션을 흉내
    mkdirSync(join(session.sessionPath, '..'), { recursive: true });
    writeFileSync(
      session.sessionPath,
      JSON.stringify({
        uuid: 'u1',
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        type: 'message',
        role: 'user',
        content: '옛 형식',
        images: [PNG],
        cwd: projectPath,
        parentUuid: null,
      }) + '\n',
      'utf8',
    );

    const loaded = loadSession(session.sessionId, projectPath);
    expect(loaded.messages[0]?.images).toEqual([PNG]);
  });

  test('세션을 지우면 이미지도 함께 정리된다', () => {
    const projectPath = join(HOME, 'proj-image-delete');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ role: 'user', content: 'x', images: [PNG] }]);

    const dir = join(session.sessionPath, '..');
    const imageDir = readdirSync(dir).find(n => n.endsWith('-images'));
    expect(imageDir).toBeDefined();

    deleteSession(session.sessionId, projectPath);
    expect(existsSync(join(dir, imageDir!))).toBe(false);
  });

  test('세션을 지우면 그 대화의 임시 폴더만 함께 지운다', () => {
    const projectPath = join(HOME, 'proj-tmp-delete');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ role: 'user', content: 'x' }]);
    const mine = join(projectPath, '.newbie', 'tmp', session.sessionId);
    const other = join(projectPath, '.newbie', 'tmp', 'other-session');
    const doc = join(projectPath, '.newbie', 'docs');
    for (const dir of [mine, other, doc]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(mine, 'verify.py'), 'print(1)');

    deleteSession(session.sessionId, projectPath);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(doc)).toBe(true);
  });

  test('경로가 섞인 세션 id는 지우지 않고 거부한다', () => {
    // 화면에서 온 id를 경로에 붙여 재귀 삭제한다. ..이 통과하면 세션 폴더 밖이 지워진다
    const projectPath = join(HOME, 'proj-bad-id');
    const victim = join(projectPath, '.newbie', 'docs');
    mkdirSync(victim, { recursive: true });

    for (const bad of ['../../docs', '..\\x', 'a/b', '', '.']) {
      expect(() => deleteSession(bad, projectPath)).toThrow('올바르지 않은 세션 id');
    }
    expect(existsSync(victim)).toBe(true);
  });
});

describe('도구 결과 이미지', () => {
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  test('도구가 돌려준 이미지도 파일로 빠지고 그대로 복원된다', () => {
    const projectPath = join(HOME, 'proj-tool-image');
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      {
        content: '',
        role: 'assistant',
        toolCalls: [
          {
            id: 'call-1',
            images: [PNG],
            input: { url: 'http://localhost:5173' },
            name: 'browser_screenshot',
            ok: true,
            result: '스크린샷을 찍었습니다',
          },
        ],
      },
    ] as any);

    // 스크린샷은 턴마다 쌓이므로 본문에 박히면 transcript가 급격히 커진다
    const raw = readFileSync(session.sessionPath, 'utf8');
    expect(raw).not.toContain('iVBORw0KGgo');
    expect(raw).toContain('imageRefs');

    const loaded = loadSession(session.sessionId, projectPath);
    const call = loaded.messages.find(m => m.toolCalls?.length)?.toolCalls?.[0];
    expect(call?.images).toEqual([PNG]);
    expect(call?.result).toBe('스크린샷을 찍었습니다');

    // 화면에 복원되는 도구 행에도 실려야 한다. 여기가 비면 세션을 다시 열었을 때
    // 모델이 무엇을 보고 판단했는지 사람은 알 수 없다
    const toolRow = loaded.rows.find(row => row.role === 'tool');
    expect(toolRow?.images).toEqual([PNG]);
  });

  test('이미지 없는 도구 이력은 예전 그대로 복원된다', () => {
    // imageRefs가 없던 시절의 세션 파일도 이 경로로 읽힌다
    const projectPath = join(HOME, 'proj-tool-plain');
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      {
        content: '',
        role: 'assistant',
        toolCalls: [
          { id: 'call-1', input: { path: 'a.ts' }, name: 'read_file', ok: true, result: '내용' },
        ],
      },
    ] as any);

    const call = loadSession(session.sessionId, projectPath).messages.find(
      m => m.toolCalls?.length,
    )?.toolCalls?.[0];
    expect(call?.images).toBeUndefined();
    expect(call?.result).toBe('내용');
  });
});

describe('컨텍스트 사용량', () => {
  // 게이지는 실측값으로 그리는데 그 값이 메모리에만 있어서, 다른 대화로 갔다
  // 오면 게이지가 빈 채로 남았다. 대화 내용은 그대로인데 얼마나 찼는지 알 수 없었다.
  test('마지막 실측값이 복원된다', () => {
    const projectPath = join(HOME, 'proj-usage');
    const session = newSession(projectPath);

    recordSessionMessages(session, [{ content: '안녕', role: 'user' }]);
    recordSessionUsage(session, { cached: 900, input: 1200, output: 300 });

    expect(loadSession(session.sessionId, projectPath).usage).toEqual({
      cached: 900,
      input: 1200,
      output: 300,
    });
  });

  test('나중 측정이 앞선 것을 덮는다', () => {
    const projectPath = join(HOME, 'proj-usage-latest');
    const session = newSession(projectPath);

    recordSessionUsage(session, { input: 100, output: 10 });
    recordSessionUsage(session, { input: 5000, output: 400 });

    expect(loadSession(session.sessionId, projectPath).usage?.input).toBe(5000);
  });

  test('기록이 없으면 undefined', () => {
    // 이 기능이 생기기 전 세션은 게이지 없이 시작한다
    const projectPath = join(HOME, 'proj-usage-none');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ content: '안녕', role: 'user' }]);

    expect(loadSession(session.sessionId, projectPath).usage).toBeUndefined();
  });
});

describe('메시지 시각', () => {
  test('보낸·읽은·완성 시각과 끼어듦 표식이 메시지와 행에 복원된다', () => {
    const projectPath = join(HOME, 'proj-times');
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      { at: '2026-08-21T03:00:00Z', content: '해줘', readAt: '2026-08-21T03:00:00Z', role: 'user' },
      {
        at: '2026-08-21T03:00:07Z',
        content: '참고로',
        interjected: true,
        readAt: '2026-08-21T03:00:09Z',
        role: 'user',
      },
      { at: '2026-08-21T03:00:20Z', content: '완료', role: 'assistant' },
    ]);

    const loaded = loadSession(session.sessionId, projectPath);
    expect(loaded.messages[1]).toMatchObject({
      at: '2026-08-21T03:00:07Z',
      interjected: true,
      readAt: '2026-08-21T03:00:09Z',
    });
    expect(loaded.rows[1]).toMatchObject({ at: '2026-08-21T03:00:07Z', readAt: '2026-08-21T03:00:09Z' });
    expect(loaded.rows[2]).toMatchObject({ at: '2026-08-21T03:00:20Z' });
    expect(loaded.rows[2]).not.toHaveProperty('readAt');
  });

  test('시각이 없던 예전 엔트리는 기록 시각으로 대신하고, 사용자 메시지는 읽은 것으로 본다', () => {
    const projectPath = join(HOME, 'proj-times-legacy');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ content: '해줘', role: 'user' }]);

    const [row] = loadSession(session.sessionId, projectPath).rows;
    expect(typeof row.at).toBe('string');
    expect(row.readAt).toBe(row.at);
  });
});

describe('추론 요약', () => {
  test('assistant 메시지의 요약이 메시지와 행 양쪽에 복원된다', () => {
    const projectPath = join(HOME, 'proj-reasoning');
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      { content: '질문', role: 'user' },
      // 도구만 부른 라운드: 본문은 비었지만 요약은 있다
      {
        content: '',
        reasoning: 'look at the file first',
        role: 'assistant',
        toolCalls: [{ id: 'c1', input: { path: 'a.ts' }, name: 'read_file', ok: true, result: 'x' }],
      },
      { content: '답', reasoning: '**Plan**\n\nthen answer', role: 'assistant' },
    ]);

    const loaded = loadSession(session.sessionId, projectPath);
    expect(loaded.messages[1].reasoning).toBe('look at the file first');
    expect(loaded.messages[2].reasoning).toBe('**Plan**\n\nthen answer');

    const assistantRows = loaded.rows.filter(row => row.role === 'assistant');
    // 본문이 빈 도구 라운드도 요약이 있으면 행이 생긴다 (실행 중 화면과 같게)
    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0].reasoning).toBe('look at the file first');
    expect(assistantRows[0].content).toBe('');
    expect(assistantRows[1].reasoning).toBe('**Plan**\n\nthen answer');
  });

  test('요약이 없는 예전 세션은 필드 자체가 없다', () => {
    const projectPath = join(HOME, 'proj-reasoning-none');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ content: '답', role: 'assistant' }]);
    const loaded = loadSession(session.sessionId, projectPath);
    expect('reasoning' in loaded.messages[0]).toBe(false);
    expect('reasoning' in loaded.rows[0]).toBe(false);
  });
});

describe('대화 설정', () => {
  // 제공자·모델·추론 강도·권한 모드가 메모리에만 있어서, 앱을 다시 켜거나 다른
  // 대화로 갔다 오면 .env 기본값으로 돌아갔다. 대화마다 고른 값이 따라와야 한다.
  test('마지막 설정이 복원된다', () => {
    const projectPath = join(HOME, 'proj-config');
    const session = {
      ...newSession(projectPath),
      model: 'gpt-5.5',
      permissionMode: 'auto',
      provider: 'openai',
      reasoningEffort: 'medium',
    };
    recordSessionMessages(session, [{ content: '안녕', role: 'user' }]);
    recordSessionConfig(session);
    session.model = 'gpt-5.6-terra';
    session.reasoningEffort = 'high';
    session.permissionMode = 'ask';
    recordSessionConfig(session);

    expect(loadSession(session.sessionId, projectPath).config).toEqual({
      model: 'gpt-5.6-terra',
      permissionMode: 'ask',
      provider: 'openai',
      reasoningEffort: 'high',
    });
  });

  test('/clear 뒤에도 설정은 남는다', () => {
    const projectPath = join(HOME, 'proj-config-clear');
    const session = { ...newSession(projectPath), model: 'claude-x', provider: 'anthropic' };
    recordSessionConfig(session);
    recordSessionClear(session);

    const loaded = loadSession(session.sessionId, projectPath);
    expect(loaded.messages).toHaveLength(0);
    expect(loaded.config?.model).toBe('claude-x');
  });

  test('모르는 권한 모드·추론 강도는 버리고 나머지는 살린다', () => {
    const projectPath = join(HOME, 'proj-config-bad');
    const session = {
      ...newSession(projectPath),
      model: 'gpt-5.5',
      permissionMode: 'yolo',
      provider: 'openai',
      reasoningEffort: 'turbo',
    };
    recordSessionConfig(session);

    expect(loadSession(session.sessionId, projectPath).config).toEqual({
      model: 'gpt-5.5',
      provider: 'openai',
    });
  });

  test('applyLoadedSession이 설정을 세션에 얹는다', () => {
    const projectPath = join(HOME, 'proj-config-apply');
    const stored = {
      ...newSession(projectPath),
      model: 'gemma4:e4b',
      permissionMode: 'acceptEdits',
      provider: 'ollama',
    };
    recordSessionConfig(stored);

    const session = {
      ...newSession(projectPath),
      model: 'gpt-5.5',
      permissionMode: 'auto',
      provider: 'openai',
      reasoningEffort: 'medium',
    };
    applyLoadedSession(session, loadSession(stored.sessionId, projectPath));
    expect(session.provider).toBe('ollama');
    expect(session.model).toBe('gemma4:e4b');
    expect(session.permissionMode).toBe('acceptEdits');
    // 기록에 없는 값은 건드리지 않는다
    expect(session.reasoningEffort).toBe('medium');
  });

  test('config 엔트리가 없는 예전 세션은 undefined', () => {
    const projectPath = join(HOME, 'proj-config-none');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ content: '안녕', role: 'user' }]);

    expect(loadSession(session.sessionId, projectPath).config).toBeUndefined();
  });
});

describe('세션 목록', () => {
  test('이미지 디렉터리를 세션으로 오인하지 않는다', () => {
    const before = listAllSessions().length;
    const projectPath = join(HOME, 'proj-listing');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ role: 'user', content: '한 건' }]);
    expect(listAllSessions().length).toBe(before + 1);
  });

  test('요약 파일을 다시 읽어도 결과가 같다', () => {
    const first = listAllSessions().map(s => s.sessionId);
    const second = listAllSessions().map(s => s.sessionId);
    expect(second).toEqual(first);
  });
});

// 목록은 transcript가 아니라 세션마다 옆에 둔 요약 파일(<세션ID>.meta.json)만 읽는다.
// 예전에는 목록을 만들 때마다 모든 transcript를 파싱했다
describe('세션 요약 파일', () => {
  const metaOf = (session: { sessionPath: string }) =>
    session.sessionPath.replace(/\.jsonl$/, '.meta.json');
  const readMeta = (session: { sessionPath: string }) =>
    JSON.parse(readFileSync(metaOf(session), 'utf8'));

  test('기록할 때마다 갱신되고, 이름 변경과 /clear도 반영된다', () => {
    const projectPath = join(HOME, 'proj-meta');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ content: '**첫** 요청', role: 'user' }]);
    expect(readMeta(session).firstPrompt).toBe('첫 요청');

    renameSession(session.sessionId, '이름', projectPath);
    expect(readMeta(session).name).toBe('이름');

    recordSessionClear(session);
    recordSessionMessages(session, [{ content: '두 번째', role: 'user' }]);
    expect(readMeta(session).firstPrompt).toBe('두 번째');
  });

  test('목록은 요약 파일만 읽는다', () => {
    const projectPath = join(HOME, 'proj-meta-only');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ content: '원본', role: 'user' }]);
    writeFileSync(metaOf(session), JSON.stringify({ ...readMeta(session), firstPrompt: '요약에서 읽음' }));
    const found = listSessions(projectPath).find(s => s.sessionId === session.sessionId);
    expect(found?.firstPrompt).toBe('요약에서 읽음');
  });

  test('요약 파일이 없는 예전 세션은 한 번 만들어 둔다', () => {
    const projectPath = join(HOME, 'proj-meta-legacy');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ content: '예전 세션', role: 'user' }]);
    rmSync(metaOf(session));

    const found = listSessions(projectPath).find(s => s.sessionId === session.sessionId);
    expect(found?.firstPrompt).toBe('예전 세션');
    expect(existsSync(metaOf(session))).toBe(true);
  });

  test('세션을 지우면 요약 파일도 지운다', () => {
    const projectPath = join(HOME, 'proj-meta-delete');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ content: 'x', role: 'user' }]);
    deleteSession(session.sessionId, projectPath);
    expect(existsSync(metaOf(session))).toBe(false);
  });
});

describe('차단된 도구 호출', () => {
  // 차단은 감사 흔적이다. ok: false로만 남기면 대화를 다시 열었을 때 "도구가
  // 오류를 냈다"로 복원돼, 무엇이 왜 막혔는지가 사라진다.
  const projectPath = join(tmpdir(), 'newbie-blocked-project');

  test('blocked가 세션에 남고 그대로 복원된다', () => {
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      { role: 'user', content: 'src 지워줘' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            blocked: true,
            id: 'c1',
            input: { command: 'rm -rf src' },
            name: 'run_command',
            ok: false,
            result: '승인하지 않아 실행하지 않았습니다 — 재귀적으로 삭제합니다 (되돌릴 수 없음)',
          },
          {
            id: 'c2',
            input: { path: 'src/cart.ts' },
            name: 'read_file',
            ok: true,
            result: '파일 내용',
          },
        ],
      },
    ]);

    const loaded = loadSession(session.sessionId, projectPath);
    const toolRows = loaded.rows.filter(row => row.role === 'tool');

    expect(toolRows.length).toBe(2);
    expect(toolRows[0].toolStatus).toBe('blocked');
    expect(toolRows[1].toolStatus).toBe('done');
  });

  test('차단 사유가 상세에 남는다', () => {
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            blocked: true,
            id: 'c1',
            input: { path: '.env' },
            name: 'read_file',
            ok: false,
            result: '승인이 필요해 실행하지 않았습니다 — 환경 변수 파일에는 API 키가 들어 있을 수 있습니다',
          },
        ],
      },
    ]);

    const loaded = loadSession(session.sessionId, projectPath);
    const row = loaded.rows.find(entry => entry.role === 'tool');
    expect(row?.result).toContain('API 키');
  });

  test('blocked가 없는 예전 세션은 실패로 복원된다', () => {
    // 이 필드가 생기기 전 세션 파일도 그대로 열려야 한다
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', input: {}, name: 'run_command', ok: false, result: '오류: 실패' },
        ],
      },
    ]);

    const loaded = loadSession(session.sessionId, projectPath);
    const row = loaded.rows.find(entry => entry.role === 'tool');
    expect(row?.toolStatus).toBe('error');
  });
});

describe('오류 행 복원', () => {
  // 저장·복원 양쪽이 필드를 화이트리스트로 다루기 때문에, 새 필드를 추가할 때
  // 한쪽만 고치면 대화를 다시 열었을 때 조치 버튼과 원문이 조용히 사라진다
  test('분류와 제공자 원문이 다시 열어도 남는다', () => {
    const projectPath = join(HOME, 'proj-error-row');
    mkdirSync(projectPath, { recursive: true });
    const session = newSession(projectPath);

    recordSessionRow(session, {
      content: '크레딧이나 할당량이 부족합니다',
      errorDetail: 'You have no credits remaining.',
      errorKind: 'quota',
      id: 'row-1',
      role: 'error',
    });

    const loaded = loadSession(session.sessionId, projectPath);
    const row = loaded.rows.find(item => item.id === 'row-1');
    expect(row?.content).toBe('크레딧이나 할당량이 부족합니다');
    expect(row?.errorKind).toBe('quota');
    expect(row?.errorDetail).toBe('You have no credits remaining.');
  });

  test('분류가 없던 예전 오류 행도 그대로 읽힌다', () => {
    const projectPath = join(HOME, 'proj-error-legacy');
    mkdirSync(projectPath, { recursive: true });
    const session = newSession(projectPath);

    recordSessionRow(session, { content: '오류: 옛 형식', id: 'row-old', role: 'error' });

    const row = loadSession(session.sessionId, projectPath).rows.find(
      item => item.id === 'row-old',
    );
    expect(row?.content).toBe('오류: 옛 형식');
    expect(row?.errorKind).toBeUndefined();
  });

  // 오류로 끝난 턴의 요청은 모델 이력에서 빠지지만 말풍선은 남아야 한다. 파일에
  // 없으면 다른 대화에 다녀왔을 때 사라지고, 다시 시도는 보이지 않는 요청에 답했다
  test('실패한 요청은 말풍선만, 다시 시도한 요청은 이력만 복원된다', () => {
    const projectPath = join(HOME, 'proj-failed-turn');
    mkdirSync(projectPath, { recursive: true });
    const session = newSession(projectPath);

    recordSessionMessages(session, [{ content: '요청', role: 'user' }], 'failed');
    recordSessionRow(session, { content: '제공자에 연결하지 못했습니다', id: 'err-1', role: 'error' });
    recordSessionMessages(session, [{ content: '요청', role: 'user' }], 'retried');
    recordSessionMessages(session, [{ content: '답변', role: 'assistant' }]);

    const loaded = loadSession(session.sessionId, projectPath);
    expect(loaded.rows.map(row => `${row.role}:${row.content}`)).toEqual([
      'user:요청',
      'error:제공자에 연결하지 못했습니다',
      'assistant:답변',
    ]);
    expect(loaded.messages.map(message => `${message.role}:${message.content}`)).toEqual([
      'user:요청',
      'assistant:답변',
    ]);
  });
});

describe('압축 체크포인트', () => {
  test('접힌 자리가 파일에 남고 다시 열면 복원된다', () => {
    const projectPath = join(HOME, 'proj-compact');
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      { content: '요청 1', role: 'user' },
      { content: '답변 1', role: 'assistant' },
      { content: '요청 2', role: 'user' },
      { content: '답변 2', role: 'assistant' },
    ]);
    recordSessionCompaction(session, { foldedCount: 2, prompts: ['요청 1'], summary: '첫 요약' });

    const loaded = loadSession(session.sessionId, projectPath);
    expect(loaded.compaction).toEqual({ foldedCount: 2, prompts: ['요청 1'], summary: '첫 요약' });

    // 세션 객체에도 그대로 실린다 — 루프가 여기서 접힌 자리를 읽는다
    const restored = newSession(projectPath);
    applyLoadedSession(restored, loaded);
    expect(restored.compaction).toEqual(loaded.compaction);
  });

  test('나중에 접은 것이 앞선 것을 덮고, clear 뒤에는 사라진다', () => {
    const projectPath = join(HOME, 'proj-compact-latest');
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      { content: '요청 1', role: 'user' },
      { content: '답변 1', role: 'assistant' },
      { content: '요청 2', role: 'user' },
    ]);
    recordSessionCompaction(session, { foldedCount: 1, prompts: [], summary: '하나' });
    recordSessionCompaction(session, { foldedCount: 2, prompts: ['요청 1'], summary: '둘' });
    expect(loadSession(session.sessionId, projectPath).compaction?.summary).toBe('둘');

    // 비운 이력에는 접힌 자리가 맞지 않는다
    recordSessionClear(session);
    recordSessionMessages(session, [{ content: '새 요청', role: 'user' }]);
    expect(loadSession(session.sessionId, projectPath).compaction).toBeUndefined();
  });

  test('접힌 수가 이력보다 크면 버린다', () => {
    // 파일이 손상됐거나 손으로 편집된 경우. 맞지 않는 자리로 접으면 이력이 통째로 사라진다
    const projectPath = join(HOME, 'proj-compact-bad');
    const session = newSession(projectPath);
    recordSessionMessages(session, [{ content: '요청 1', role: 'user' }]);
    recordSessionCompaction(session, { foldedCount: 5, prompts: [], summary: 'x' });

    expect(loadSession(session.sessionId, projectPath).compaction).toBeUndefined();
  });
});

describe('종료 사유 복원', () => {
  // 저장·복원 양쪽이 필드를 화이트리스트로 다루므로 한쪽만 고치면 조용히 사라진다
  test('assistant의 stopReason이 다시 열어도 남는다', () => {
    const projectPath = join(HOME, 'proj-stop-reason');
    mkdirSync(projectPath, { recursive: true });
    const session = newSession(projectPath);
    recordSessionMessages(session, [
      { role: 'user', content: '길게 써줘' },
      { role: 'assistant', content: '여기까지 쓰다가', stopReason: 'length' },
    ]);

    const loaded = loadSession(session.sessionId, projectPath);
    const answer = loaded.messages.find(m => m.role === 'assistant');
    expect(answer?.stopReason).toBe('length');
  });
});
