// /remember 커맨드 — 명시적 메모리 저장.
//
// 분류(이름·설명·타입)는 LLM에 맡기지만 저장은 LLM 없이도 되어야 한다. mock
// 세션과 분류 실패 경로에서는 이름·설명만 대체되고 파일은 반드시 남는다.
// 같은 slug가 이미 있으면 덮어쓰지 않고 덧붙인다 — 사용자가 직접 준 말을 잃지 않는다.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `newbie-remember-cmd-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

// distillCheckpoint.test.ts와 같은 방식 — LM Studio 호환 로컬 서버로 분류 응답을 흉내낸다
let llmOutput = '';

const server = Bun.serve({
  port: 0,
  fetch() {
    const chunk = JSON.stringify({
      choices: [{ delta: { content: llmOutput } }],
    });
    return new Response(`data: ${chunk}

data: [DONE]

`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});

process.env.LM_STUDIO_BASE_URL = `http://127.0.0.1:${server.port}`;

const { rememberCommand } = await import('../src/commands/builtins/remember.ts');
const { getMemoryBaseDir, getMemoryIndexPath } = await import('../src/memory/paths.ts');
const { parseFrontmatter } = await import('../src/memory/scan.ts');

const mockSession = { mock: true } as any;
const llmSession = {
  mock: false,
  provider: 'lmstudio',
  model: 'test-model',
  maxTokens: 256,
  messages: [],
} as any;

async function run(session: unknown, args: string) {
  const rows: any[] = [];
  await rememberCommand.run(
    { appendRow: (row: any) => rows.push(row), session } as any,
    args,
    '',
  );
  return rows;
}

function topicFiles(): string[] {
  if (!existsSync(getMemoryBaseDir())) return [];
  return readdirSync(getMemoryBaseDir()).filter(
    name => name.endsWith('.md') && name !== 'MEMORY.md',
  );
}

function readTopic(name: string) {
  return parseFrontmatter(readFileSync(join(getMemoryBaseDir(), `${name}.md`), 'utf8'));
}

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  llmOutput = '';
});

afterEach(() => rmSync(HOME, { recursive: true, force: true }));

afterAll(() => server.stop(true));

describe('인수 검증', () => {
  test('내용이 없으면 안내만 하고 아무것도 쓰지 않는다', async () => {
    const rows = await run(mockSession, '   ');

    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain('기억할 내용을 함께 적어주세요');
    expect(existsSync(getMemoryBaseDir())).toBe(false);
  });

  test('모르는 타입은 거부한다', async () => {
    const rows = await run(mockSession, '--type insight 답변은 짧게');

    expect(rows.at(-1).content).toContain('타입은 user·feedback·project·reference 중 하나');
    expect(topicFiles()).toHaveLength(0);
  });
});

describe('LLM 없이 저장', () => {
  test('mock 세션에서도 confirmed topic과 인덱스 줄이 남는다', async () => {
    const rows = await run(mockSession, '답변은 짧게, 인사 없이');

    const files = topicFiles();
    expect(files).toHaveLength(1);
    const name = files[0].replace(/\.md$/, '');
    expect(name).toMatch(/^note-\d{8}-\d{6}$/);

    const { frontmatter, body } = readTopic(name);
    expect(frontmatter.source).toBe('confirmed');
    expect(frontmatter.type).toBe('user');
    expect(body).toBe('답변은 짧게, 인사 없이');

    expect(readFileSync(getMemoryIndexPath(), 'utf8')).toContain(`[${name}](${name}.md)`);
    expect(rows.at(-1)).toMatchObject({ role: 'system' });
    expect(rows.at(-1).content).toContain('새 topic으로 저장했어요');
  });

  test('--type을 주면 그 타입으로 저장한다', async () => {
    await run(mockSession, '--type feedback 답변은 짧게');

    const [file] = topicFiles();
    expect(readTopic(file.replace(/\.md$/, '')).frontmatter.type).toBe('feedback');
  });
});

describe('LLM 분류', () => {
  test('LLM이 준 이름·설명·타입으로 저장한다', async () => {
    llmOutput = JSON.stringify({
      name: 'answer-style',
      description: '짧은 답변 선호',
      type: 'feedback',
    });

    const rows = await run(llmSession, '답변은 짧게, 인사 없이');

    const { frontmatter, body } = readTopic('answer-style');
    expect(frontmatter.type).toBe('feedback');
    expect(frontmatter.description).toBe('짧은 답변 선호');
    expect(frontmatter.source).toBe('confirmed');
    expect(body).toBe('답변은 짧게, 인사 없이');
    expect(readFileSync(getMemoryIndexPath(), 'utf8')).toContain(
      '- [answer-style](answer-style.md) — 짧은 답변 선호',
    );
    expect(rows.at(-1).content).toContain('[answer-style] (feedback)');
  });

  test('--type은 LLM 분류보다 우선한다', async () => {
    llmOutput = JSON.stringify({ name: 'answer-style', description: '짧은 답변', type: 'user' });

    await run(llmSession, '--type feedback 답변은 짧게');

    expect(readTopic('answer-style').frontmatter.type).toBe('feedback');
  });

  test('같은 slug가 있으면 본문 뒤에 덧붙인다', async () => {
    llmOutput = JSON.stringify({ name: 'answer-style', description: '짧은 답변', type: 'feedback' });
    await run(llmSession, '답변은 짧게');

    const rows = await run(llmSession, '인사도 빼고');

    expect(readTopic('answer-style').body).toBe('답변은 짧게\n\n인사도 빼고');
    expect(topicFiles()).toHaveLength(1);
    expect(rows.at(-1).content).toContain('기존 topic에 덧붙였어요');
  });

  test('잘못된 slug는 파일 이름으로 쓰지 않고 대체 이름으로 저장한다', async () => {
    llmOutput = JSON.stringify({ name: '../../Newbie', description: '탈출', type: 'user' });

    await run(llmSession, '기억해');

    const files = topicFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^note-\d{8}-\d{6}\.md$/);
    expect(existsSync(join(HOME, 'Newbie.md'))).toBe(false);
  });

  test('응답이 JSON이 아니어도 저장된다', async () => {
    llmOutput = '분류할 수 없습니다.';

    const rows = await run(llmSession, '기억해 둘 것');

    expect(topicFiles()).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ role: 'system' });
  });
});
