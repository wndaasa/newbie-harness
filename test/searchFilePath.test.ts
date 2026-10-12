// search_files가 path에 파일 하나를 받을 때의 회귀 테스트.
//
// 모델은 "이 파일 안에서 register를 찾자"며 path에 파일 경로를 넣는데, 디렉터리만
// 받던 시절엔 "디렉터리가 아닙니다"로 끝났다. rg는 파일을 직접 받아도 검색하지만
// 파일 하나면 파일명을 생략하므로, 결과 형식("절대경로:줄번호:내용")이 유지되는지도
// 같이 고정한다.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { runInWorkdir } from '../src/agent/workdir.ts';
import { dispatchTool } from '../src/tools/registry.ts';
import '../src/tools/search/searchFiles.ts';

const root = mkdtempSync(join(tmpdir(), 'newbie-search-file-'));
const file = join(root, 'services.js');
writeFileSync(file, 'const a = 1;\nfunction register(app) {}\nmodule.exports = { register };\n');

afterAll(() => {
  try {
    rmSync(root, { force: true, recursive: true });
  } catch {
    // Windows에서 잠겨 있으면 임시 폴더 청소는 포기해도 된다
  }
});

test('path가 파일이면 그 파일 안을 검색하고 결과에 파일 경로가 붙는다', async () => {
  const result = await runInWorkdir(root, () =>
    dispatchTool('search_files', { path: 'services.js', query: 'register' }),
  );
  expect(result.text).not.toContain('디렉터리가 아닙니다');
  expect(result.text).toContain(`${file}:2:`);
  expect(result.text).toContain(`${file}:3:`);
  expect(result.text).not.toContain(':1:');
});

test('디렉터리 검색의 결과 형식은 그대로다', async () => {
  const result = await runInWorkdir(root, () =>
    dispatchTool('search_files', { path: '.', query: 'register' }),
  );
  expect(result.text).toContain(`${file}:2:`);
});
