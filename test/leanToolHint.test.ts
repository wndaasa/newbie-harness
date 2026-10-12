// 매 요청 고정분을 줄인 뒤의 도구 목록과 안내를 고정한다.
//
// 코딩 탭은 시스템 프롬프트에 도구 설명 산문(1,500토큰)과 도구 정의(3,000토큰)를
// 함께 실었다. 산문은 정의와 같은 내용이라 뺐고, 대체 수단이 있는 드문 내장 도구는
// 정의를 빼고 시그니처 한 줄만 알린다.

import { afterEach, describe, expect, test } from 'bun:test';

const { dispatchTool, getOpenAITools, setToolMode } = await import('../src/tools/registry.ts');
const { buildToolHint } = await import('../src/tools/prompt.ts');
await import('../src/agent/loop.ts');

const names = (mode: 'chat' | 'coding') =>
  (getOpenAITools(mode) as { function: { name: string } }[]).map(t => t.function.name);

afterEach(() => {
  setToolMode('coding');
});

describe('코딩 도구 안내', () => {
  test('도구 설명을 되풀이하지 않는다', () => {
    const hint = buildToolHint('coding');
    // 정의(JSON)에 있는 설명이 산문으로 또 나가면 그만큼이 매 요청 비용이다
    expect(hint).not.toContain('read_file(path');
    expect(hint).not.toContain('edit_file(path');
    expect(hint).not.toContain('다음 도구를 사용할 수 있음');
    // 정의에 담을 수 없는 정책은 남는다
    expect(hint).toContain('승인을 요구하거나 거부될 수 있음');
  });

  test('지연 내장 도구는 시그니처로 알리고 이름으로 바로 부르게 한다', () => {
    const hint = buildToolHint('coding');
    expect(hint).toContain('이름으로 바로 호출 가능');
    expect(hint).toContain('get_file_info(path)');
    expect(hint).toContain('delete_file(path)');
  });
});

describe('코딩 도구 목록', () => {
  test('드문 도구는 목록에서 빠지고 핵심 도구는 남는다', () => {
    const list = names('coding');
    for (const gone of ['delete_file', 'get_file_info']) {
      expect(list).not.toContain(gone);
    }
    // 대체 수단이 없는 도구는 목록에 둔다. 작은 모델은 목록에 없는 도구를 시그니처만
    // 보고는 부르지 않았다 — "get_file_info를 써라"고 해도 run_command stat으로 갔다
    for (const kept of ['read_file', 'search_files', 'list_files', 'edit_file', 'create_file', 'run_command', 'run_git', 'spawn_agent', 'web_search', 'search_tools', 'capture_page', 'parse_document', 'start_process', 'read_process', 'stop_process']) {
      expect(list).toContain(kept);
    }
  });

  test('목록에 없어도 이름으로 부르면 실행된다', async () => {
    // 시그니처만 보고 부르는 경로. 불러오기(load_tools)를 요구하면 8B는 거기서 막힌다
    const outcome = await dispatchTool('get_file_info', { path: 'package.json' });
    expect(outcome.text).toContain('package.json');
  });

  test('채팅 탭의 웹 도구는 그대로다', () => {
    // web_search·web_fetch는 채팅 탭의 유일한 도구라 지연시키면 채팅이 도구를 잃는다
    const list = names('chat');
    expect(list).toContain('web_search');
    expect(list).toContain('web_fetch');
  });
});
