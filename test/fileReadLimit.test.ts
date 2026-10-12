// 파일 읽기 상한 회귀 테스트.
//
// 예전에는 offset/limit를 주지 않으면 파일 전체(최대 1MB)를 돌려줬다. 1MB면
// 25만 토큰이라, 파일 네 번 읽고 27,000 토큰이 들어와 40,960짜리 창이 한
// 라운드 만에 찼다. 잘랐다는 사실과 이어 읽는 법을 결과에 함께 남기는지까지 본다.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchTool } from '../src/tools/registry.ts';
import { DEFAULT_READ_LINES } from '../src/tools/read/limits.ts';
import '../src/tools/read/readFile.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'newbie-read-'));
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

async function read(args: Record<string, unknown>): Promise<string> {
  return (await dispatchTool('read_file', args as never)).text;
}

function writeLines(name: string, count: number): string {
  const path = join(dir, name);
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) lines.push(`줄 ${i}`);
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

describe('read_file 상한', () => {
  test('limit 없이도 기본 상한까지만 돌려준다', async () => {
    const output = await read({ path: writeLines('big.txt', 5_000) });

    // 전체를 돌려주면 이 한 번으로 컨텍스트가 찬다
    expect(output).toContain(`줄 범위: 1-${DEFAULT_READ_LINES}`);
    expect(output).not.toContain(`줄 ${DEFAULT_READ_LINES + 1}\n`);
  });

  test('잘렸으면 이어 읽는 법을 알려준다', async () => {
    const output = await read({ path: writeLines('big.txt', 5_000) });

    // 조용히 자르면 모델은 파일이 거기서 끝난 줄 알고 잘못된 판단을 한다
    expect(output).toContain(`offset=${DEFAULT_READ_LINES + 1}`);
  });

  test('짧은 파일은 다 돌려주고 안내도 붙이지 않는다', async () => {
    const path = join(dir, 'small.txt');
    writeFileSync(path, '한 줄\n두 줄\n세 줄', 'utf8');

    const output = await read({ path });
    expect(output).toContain('세 줄');
    expect(output).not.toContain('뒷부분 생략됨');
  });

  test('한 줄이 아주 긴 파일도 막는다', async () => {
    const path = join(dir, 'bundle.js');
    // 번들·최소화된 JS는 줄 수로만 막으면 통째로 들어온다
    writeFileSync(path, 'x'.repeat(200_000), 'utf8');

    expect((await read({ path })).length).toBeLessThan(40_000);
  });

  test('offset으로 이어 읽을 수 있다', async () => {
    const path = writeLines('big.txt', 5_000);

    const next = await read({ path, offset: DEFAULT_READ_LINES + 1 });
    expect(next).toContain(`줄 범위: ${DEFAULT_READ_LINES + 1}-`);
  });
});

describe('경로 오류 메시지', () => {
  test('못 찾으면 어디를 찾았는지와 기준 폴더를 알려준다', async () => {
    // 예전에는 "파일을 찾을 수 없습니다: app/x.java"만 돌려줬다. 어느
    // 폴더에서 풀었는지가 없으니 모델은 엉뚱한 데를 찾았다는 걸 모른 채 같은
    // 상대경로로 계속 다시 시도한다 — 실제로 겪은 증상이다
    const failure = await dispatchTool('read_file', { path: 'app/없는파일.java' } as never)
      .then(() => null, (error: Error) => error.message);

    expect(failure).toContain('ENOENT');
    expect(failure).toContain('찾은 위치:');
    expect(failure).toContain('기준 폴더:');
  });

  test('절대경로 오류에는 기준 폴더를 붙이지 않는다', async () => {
    const failure = await dispatchTool('read_file', {
      path: join(dir, '없는파일.java'),
    } as never).then(() => null, (error: Error) => error.message);

    // 절대경로는 기준 폴더와 무관하다 — 붙이면 오해만 부른다
    expect(failure).toContain('찾은 위치:');
    expect(failure).not.toContain('기준 폴더:');
  });

  test('디렉터리를 읽으려 하면 그렇게 말해 준다', async () => {
    const failure = await dispatchTool('read_file', { path: dir } as never)
      .then(() => null, (error: Error) => error.message);

    // "파일을 찾을 수 없습니다"로 뭉개면 모델이 경로를 계속 바꿔 가며 헤맨다
    expect(failure).toContain('디렉터리');
  });

  test('목록에 기준 경로를 함께 준다', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x', 'utf8');
    const out = (await dispatchTool('list_files', { path: dir } as never)).text;

    // 이름만 주면 모델이 앞 경로를 스스로 이어 붙이다 흘린다
    expect(out).toContain(`기준 경로: ${dir}`);
    expect(out).toContain('[FILE] a.txt');
  });
});
