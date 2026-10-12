// 턴별 작업 디렉터리 회귀 테스트.
//
// 도구는 process.cwd()가 아니라 턴에 고정된 폴더를 기준으로 상대 경로를 풀어야
// 한다. 세션을 옮기면 전역 cwd가 바뀌는데, 백그라운드로 도는 턴의 도구가 그걸
// 따라가면 남의 프로젝트를 읽고 쓴다. 동시에 도는 두 턴이 서로의 폴더를 보지
// 않는 것까지 고정한다.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { getWorkdir, runInWorkdir } from '../src/agent/workdir.ts';
import { dispatchTool } from '../src/tools/registry.ts';
import '../src/tools/read/readFile.ts';
import '../src/tools/search/searchFiles.ts';

const root = mkdtempSync(join(tmpdir(), 'newbie-workdir-'));
const alpha = join(root, 'alpha');
const beta = join(root, 'beta');
mkdirSync(alpha);
mkdirSync(beta);
writeFileSync(join(alpha, 'only-in-alpha.txt'), 'alpha\n');
writeFileSync(join(beta, 'only-in-beta.txt'), 'beta\n');

afterAll(() => {
  try {
    rmSync(root, { force: true, recursive: true });
  } catch {
    // Windows에서 잠겨 있으면 임시 폴더 청소는 포기해도 된다
  }
});

test('컨텍스트 밖에서는 프로세스의 cwd를 돌려준다', () => {
  expect(getWorkdir()).toBe(process.cwd());
});

test('상대 경로 도구는 턴의 폴더를 기준으로 푼다', async () => {
  const listing = await runInWorkdir(alpha, () => dispatchTool('list_files', { path: '.' }));
  expect(listing.text).toContain('only-in-alpha.txt');
  expect(listing.text).not.toContain('only-in-beta.txt');

  const read = await runInWorkdir(beta, () => dispatchTool('read_file', { path: 'only-in-beta.txt' }));
  expect(read.text).toContain('beta');
});

test('동시에 도는 두 턴은 서로의 폴더를 보지 않는다', async () => {
  // await를 사이에 끼워 두 흐름이 실제로 교차하게 만든다
  const probe = (cwd: string) =>
    runInWorkdir(cwd, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const before = getWorkdir();
      const listing = await dispatchTool('list_files', { path: '.' });
      await new Promise(resolve => setTimeout(resolve, 5));
      return { after: getWorkdir(), before, text: listing.text };
    });

  const [a, b] = await Promise.all([probe(alpha), probe(beta)]);
  expect(a.before).toBe(alpha);
  expect(a.after).toBe(alpha);
  expect(a.text).toContain('only-in-alpha.txt');
  expect(b.before).toBe(beta);
  expect(b.after).toBe(beta);
  expect(b.text).toContain('only-in-beta.txt');
});

test('검색 도구도 턴의 폴더에서 출발한다', async () => {
  const result = await runInWorkdir(alpha, () =>
    dispatchTool('search_files', { glob: '*.txt', path: '.' }),
  );
  expect(result.text).toContain('only-in-alpha.txt');
  expect(result.text).not.toContain('only-in-beta.txt');
});
