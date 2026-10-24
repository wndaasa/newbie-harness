// 채팅 모드 회귀 테스트.
//
// 핵심은 "채팅 탭에서 코딩 도구 정의가 안 나간다"는 것이다. 도구 정의는
// 요청마다 통째로 다시 나가므로, 여기가 새면 대화 내내 비용이 샌다.

import { afterEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NEWBIE_HOME = join(tmpdir(), `newbie-chatmode-${process.pid}`);
process.env.NEWBIE_DISABLE_NEWBIE_MD = '1';

// 도구가 실제로 등록돼 있어야 목록을 잴 수 있다
import '../src/tools/read/readFile.ts';
import '../src/tools/write/writeFile.ts';
import '../src/tools/shell/runCommand.ts';
import '../src/tools/web/webSearch.ts';
import '../src/tools/web/webFetch.ts';
import '../src/tools/lazyTools/lazyTools.ts';

const { getOpenAITools, setToolMode } = await import('../src/tools/registry.ts');
const { buildToolHint } = await import('../src/tools/prompt.ts');

const toolNames = () => getOpenAITools().map(tool => tool.function.name);

afterEach(() => {
  setToolMode('coding');
});

describe('모드별 도구 목록', () => {
  test('코딩 모드에는 파일·셸 도구가 있다', () => {
    setToolMode('coding');
    const names = toolNames();
    expect(names).toContain('read_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('run_command');
  });

  test('채팅 모드에는 쓰기·셸 도구가 없다', () => {
    setToolMode('chat');
    const names = toolNames();
    expect(names).not.toContain('create_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('delete_file');
    expect(names).not.toContain('run_command');
    expect(names).not.toContain('start_process');
  });

  test('채팅 모드에도 읽기 도구는 있다 (첨부 문서를 읽으려면 필요)', () => {
    setToolMode('chat');
    const names = toolNames();
    expect(names).toContain('read_file');
    expect(names).toContain('parse_document');
    expect(names).not.toContain('search_files');
    expect(names).not.toContain('list_files');
  });

  test('채팅 모드에도 웹 도구는 있다', () => {
    setToolMode('chat');
    const names = toolNames();
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
  });

  test('채팅 모드에도 도구 검색은 있다 (MCP를 찾아 쓰려면 필요)', () => {
    setToolMode('chat');
    const names = toolNames();
    expect(names).toContain('search_tools');
    expect(names).toContain('load_tools');
  });

  test('채팅 모드 도구 수가 코딩보다 확실히 적다', () => {
    setToolMode('coding');
    const coding = toolNames().length;
    setToolMode('chat');
    const chat = toolNames().length;
    expect(chat).toBeLessThan(coding / 2);
  });
});

describe('도구 힌트 분량', () => {
  test('채팅 힌트에는 코딩 도구 설명이 없다', () => {
    setToolMode('chat');
    const hint = buildToolHint();
    expect(hint).not.toContain('edit_file');
    expect(hint).not.toContain('run_command');
    expect(hint).not.toContain('search_files');
  });

  test('힌트는 두 모드 모두 짧다', () => {
    // 코딩 힌트는 도구 설명을 되풀이하지 않는다 — 정의(JSON)로 이미 나간다.
    // 예전엔 6천 자가 넘어 매 요청 1,500토큰이 두 번 나갔다
    setToolMode('coding');
    expect(buildToolHint().length).toBeLessThan(1_500);
    setToolMode('chat');
    expect(buildToolHint().length).toBeLessThan(600);
  });
});

describe('시스템 프롬프트', () => {
  test('채팅 프롬프트에는 코딩 지시가 없다', async () => {
    const { buildSystemPrompt, createSession } = await import('../src/config.ts');
    setToolMode('chat');
    const session = createSession({ mock: true, noMemory: true });
    session.mode = 'chat';
    const prompt = await buildSystemPrompt(session);

    expect(prompt).toContain('chat tab');
    // 파일 수정·조사 규칙이 통째로 실리면 안 된다
    expect(prompt).not.toContain('edit_file');
    expect(prompt).not.toContain('Investigation rules');
    // git status 스냅샷은 파일이 바뀔 때마다 달라져 캐시를 깬다
    expect(prompt).not.toContain('현재 작업 디렉터리');
  });

  test('코딩 프롬프트는 그대로다', async () => {
    const { buildSystemPrompt, buildTurnEnvContext, createSession } = await import('../src/config.ts');
    setToolMode('coding');
    const session = createSession({ mock: true, noMemory: true });
    session.mode = 'agent';
    const prompt = await buildSystemPrompt(session);

    expect(prompt).toContain('Investigation rules');
    // 환경 정보는 매 턴 바뀌므로 시스템 프롬프트가 아니라 대화 끝에 붙는다 —
    // 시스템 프롬프트에 두면 뒤의 이력 전체가 캐시에서 밀린다
    expect(prompt).not.toContain('현재 작업 디렉터리');
    expect(await buildTurnEnvContext(session)).toContain('현재 작업 디렉터리');
  });

  test('세 프롬프트 모두 긴 파일과 문서를 처음부터 넘겨 읽지 말고 필요한 부분만 읽으라고 한다', async () => {
    // 1만 행 용어 사전을 통째로 변환해 창의 세 배가 들어오고 턴이 멈췄다. 도구 설명에만
    // 두면 큰 텍스트 파일을 read_file로 넘겨 읽는 경우는 막지 못한다
    const { buildSubagentSystemPrompt, buildSystemPrompt, createSession } = await import('../src/config.ts');
    const session = createSession({ mock: true, noMemory: true });

    setToolMode('coding');
    session.mode = 'agent';
    expect(await buildSystemPrompt(session)).toContain('do not page through it from top to bottom');
    for (const kind of ['explore', 'general'] as const) {
      expect(await buildSubagentSystemPrompt(session, kind, () => true)).toContain(
        'do not page through it from top to bottom',
      );
    }

    setToolMode('chat');
    session.mode = 'chat';
    expect(await buildSystemPrompt(session)).toContain('read only the parts you need');
  });

  test('코딩 프롬프트만 보조 에이전트 등급 기준을 싣는다', async () => {
    // 대화 모델은 그대로 두고 조각만 아래 등급에 넘긴다(턴마다 모델을 바꾸면 캐시가 깨진다).
    // 언제 fast로 내리고 언제 strong에 두는지는 대화 모델이 이 기준으로 판단한다
    const { buildSystemPrompt, createSession } = await import('../src/config.ts');
    const session = createSession({ mock: true, noMemory: true });

    setToolMode('coding');
    session.mode = 'agent';
    const coding = await buildSystemPrompt(session);
    expect(coding).toContain('Pick the cheapest tier');
    expect(coding).toContain('tier "fast"');
    expect(coding).toContain('retried on strong automatically');

    setToolMode('chat');
    session.mode = 'chat';
    expect(await buildSystemPrompt(session)).not.toContain('tier "fast"');
  });

  test('채팅 프롬프트가 코딩보다 훨씬 짧다', async () => {
    const { buildSystemPrompt, createSession } = await import('../src/config.ts');
    const session = createSession({ mock: true, noMemory: true });

    setToolMode('coding');
    session.mode = 'agent';
    const coding = (await buildSystemPrompt(session)).length;

    setToolMode('chat');
    session.mode = 'chat';
    const chat = (await buildSystemPrompt(session)).length;

    expect(chat).toBeLessThan(coding / 3);
  });
});
