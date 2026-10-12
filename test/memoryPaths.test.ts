// 정책 파일 위치 회귀 테스트.
//
// policy.md가 생성 메모리와 같은 memory/ 아래 있으면 scanTopicFiles가 topic으로
// 집어 리콜에 주입하고, /distill이 "기존 topic"으로 LLM에 넘겨 frontmatter 붙은
// 파일로 덮어쓴다. 사용자가 손으로 쓴 정책이 소실된다.
//
// NEWBIE_HOME을 임시 경로로 돌려 실제 ~/.newbie와 격리한다.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `newbie-policy-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

const { getMemoryBaseDir, getPolicyPath } = await import('../src/memory/paths.ts');
const { scanTopicFiles } = await import('../src/memory/scan.ts');
const { loadMemoryContext } = await import('../src/memory/recall.ts');

const POLICY_BODY = '# 내 메모리 정책\n- 건강 관련 내용은 절대 저장하지 마\n';

beforeAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(getMemoryBaseDir(), { recursive: true });
  writeFileSync(getPolicyPath(), POLICY_BODY, 'utf8');
  writeFileSync(
    join(getMemoryBaseDir(), 'a.md'),
    '---\nname: a\ntype: user\nsource: confirmed\n---\n\n본문\n',
    'utf8',
  );
});

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test('정책 파일은 사용자 소유 영역(NEWBIE_HOME 최상위)에 있다', () => {
  expect(getPolicyPath()).toBe(join(HOME, 'policy.md'));
});

test('정책 파일은 topic 스캔 대상이 아니다', () => {
  expect(scanTopicFiles(getMemoryBaseDir()).map(t => t.slug)).toEqual(['a']);
});

test('정책 파일 내용이 리콜 컨텍스트에 주입되지 않는다', () => {
  const context = loadMemoryContext();
  expect(context).toContain('본문');
  expect(context).not.toContain('내 메모리 정책');
});
