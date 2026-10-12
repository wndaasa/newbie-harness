// /recall 커맨드 — 저장된 기억 확인·검색.
//
// 인수가 없으면 MEMORY.md 인덱스를, 키워드가 있으면 이름·설명·본문 검색 결과를
// 보여준다. 시스템 프롬프트 리콜과 달리 insight도 찾되 source로 구분한다.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `newbie-recall-cmd-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

const { recallCommand } = await import('../src/commands/builtins/recall.ts');
const { updateMemoryIndex, writeTopicFile } = await import('../src/memory/distill.ts');
const { getInsightsBaseDir, getMemoryBaseDir, getMemoryIndexPath } = await import(
  '../src/memory/paths.ts'
);

function run(args: string): string {
  const rows: any[] = [];
  recallCommand.run({ appendRow: (row: any) => rows.push(row) } as any, args, '');
  expect(rows).toHaveLength(1);
  expect(rows[0].role).toBe('system');
  return rows[0].content as string;
}

function seed() {
  writeTopicFile(
    {
      name: 'unity-lead',
      description: 'Unity 연구과제 리딩',
      type: 'project',
      body: 'Unity 연구과제 팀을 이끈다.\n협업 규칙은 Git 기준.',
      source: 'confirmed',
    },
    getMemoryBaseDir(),
  );
  writeTopicFile(
    {
      name: 'concise-answers',
      description: '짧은 답 선호',
      type: 'insight',
      body: '짧고 직설적인 답을 반복해서 요구했다.',
      source: 'inferred',
    },
    getInsightsBaseDir(),
  );
  updateMemoryIndex(
    [
      { name: 'unity-lead', description: 'Unity 연구과제 리딩', link: 'unity-lead.md' },
      { name: 'concise-answers', description: '짧은 답 선호', link: 'insights/concise-answers.md' },
    ],
    getMemoryIndexPath(),
  );
}

beforeEach(() => rmSync(HOME, { recursive: true, force: true }));
afterEach(() => rmSync(HOME, { recursive: true, force: true }));

describe('인덱스', () => {
  test('저장된 기억이 없으면 안내한다', () => {
    expect(run('')).toContain('저장된 기억이 없어요');
  });

  test('인수가 없으면 개수와 인덱스 줄을 보여준다', () => {
    seed();
    const content = run('');

    expect(content).toContain('기억 2개');
    expect(content).toContain('- [unity-lead](unity-lead.md) — Unity 연구과제 리딩');
    expect(content).toContain('- [concise-answers](insights/concise-answers.md) — 짧은 답 선호');
  });
});

describe('검색', () => {
  test('대소문자 구분 없이 topic을 찾고 일치한 본문 줄을 붙인다', () => {
    seed();
    const content = run('UNITY');

    expect(content).toContain("'UNITY' 관련 기억 1개");
    expect(content).toContain('- [unity-lead] (project · 확인됨) — Unity 연구과제 리딩');
    expect(content).toContain('    Unity 연구과제 팀을 이끈다.');
    expect(content).not.toContain('협업 규칙'); // 키워드가 없는 줄은 붙이지 않는다
    expect(content).not.toContain('concise-answers');
  });

  test('insight도 찾되 추정으로 표시한다', () => {
    seed();
    const content = run('직설');

    expect(content).toContain('- [concise-answers] (insight · 추정) — 짧은 답 선호');
  });

  test('일치하는 기억이 없으면 안내한다', () => {
    seed();
    expect(run('없는키워드')).toBe("'없는키워드' 관련 기억이 없어요.");
  });
});
