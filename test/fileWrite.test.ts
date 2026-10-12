// 파일 편집 회귀 테스트.
//
// edit_file은 원본을 먼저 덮어쓴 뒤 구문을 검사하고 실패하면 되돌리는
// 순서였다. 그 사이에 프로세스가 죽으면 깨진 내용만 남는다. 검사를 통과한
// 뒤에 한 번만 쓰도록 바꾼 것을 고정한다.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { editFileTool } from '../src/tools/write/writeFile.ts';
import { markFileRead } from '../src/tools/read/readFile.ts';

const dirs: string[] = [];

function scratchFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'newbie-edit-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  // edit_file은 read_file로 먼저 읽은 파일만 수정할 수 있다
  markFileRead(path);
  return path;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('CRLF 관용 매칭', () => {
  test('LF로만 적은 old_string이 CRLF 파일에서도 그 자리를 찾아 CRLF를 유지한 채 바꾼다', () => {
    // Windows에서 만들어진 파일은 줄바꿈이 \r\n인데, read_file이 \r을 그대로
    // 돌려줘도 화면에 보이지 않아 모델이 old_string을 \n으로만 옮겨 적는 일이 흔했다
    const original = "if (x) {\r\n  return 1;\r\n}\r\n";
    const path = scratchFile('sample.js', original);

    editFileTool(path, 'if (x) {\n  return 1;\n}', 'if (x) {\n  return 2;\n}');

    expect(readFileSync(path, 'utf8')).toBe("if (x) {\r\n  return 2;\r\n}\r\n");
  });

  test('개행이 섞인 파일에서는 정규식으로 그 자리에 실제로 있는 개행만 바꾸고 나머지는 그대로 둔다', () => {
    // 대상 구간만 CRLF, 그 앞은 LF인 파일. 전체를 LF로 맞췄다가 되돌리는 방식이면
    // 이런 경우 엉뚱하게 아무것도 안 바뀌거나 앞부분까지 CRLF로 바뀔 수 있다
    const original = 'const a = 1;\nif (x) {\r\n  return 1;\r\n}\r\n';
    const path = scratchFile('sample.js', original);

    editFileTool(path, 'if (x) {\n  return 1;\n}', 'if (x) {\n  return 2;\n}');

    expect(readFileSync(path, 'utf8')).toBe('const a = 1;\nif (x) {\r\n  return 2;\r\n}\r\n');
  });

  test('정규식 특수문자가 든 old_string도 CRLF 파일에서 그대로 리터럴로 찾는다', () => {
    const original = "const re = /a.b/;\r\nconst n = (1 + 2);\r\n";
    const path = scratchFile('sample.js', original);

    editFileTool(path, 'const re = /a.b/;\nconst n = (1 + 2);', 'const re = /a.b/;\nconst n = (3 + 4);');

    expect(readFileSync(path, 'utf8')).toBe("const re = /a.b/;\r\nconst n = (3 + 4);\r\n");
  });

  test('CRLF로 맞춰도 여러 곳과 일치하면 그대로 거부한다', () => {
    const original = 'if (x) {\r\n  y();\r\n}\r\nif (x) {\r\n  y();\r\n}\r\n';
    const path = scratchFile('sample.js', original);

    expect(() => editFileTool(path, 'if (x) {\n  y();\n}', 'z();')).toThrow(/일치합니다/);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  test('\\r을 이미 포함한 old_string은 있는 그대로만 맞춘다', () => {
    const original = 'a\nb\n';
    const path = scratchFile('sample.js', original);

    // \r이 든 old_string이 CRLF 관용 경로를 타면 안 된다 — 파일에 그런 문자열은 없다
    expect(() => editFileTool(path, 'a\r\nb', 'x')).toThrow(/일치하지 않습니다/);
  });
});

describe('구문 검사', () => {
  test('결과가 깨지면 파일을 건드리지 않는다', () => {
    const original = 'export const a = 1;\n';
    const path = scratchFile('sample.ts', original);

    expect(() => editFileTool(path, 'const a = 1;', 'const a = (((;')).toThrow();
    // 되돌린 것이 아니라 애초에 쓰지 않아야 한다
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  test('정상 수정은 반영된다', () => {
    const path = scratchFile('sample.ts', 'export const a = 1;\n');
    const result = editFileTool(path, 'const a = 1;', 'const a = 2;');

    expect(readFileSync(path, 'utf8')).toBe('export const a = 2;\n');
    expect(result.syntaxChecked).toBe(true);
  });

  test('구문 검사 대상이 아닌 확장자는 그대로 쓴다', () => {
    const path = scratchFile('notes.md', '# 제목\n');
    editFileTool(path, '# 제목', '# 바뀐 제목');

    expect(readFileSync(path, 'utf8')).toBe('# 바뀐 제목\n');
  });
});

describe('교체 대상 지정', () => {
  test('일치하는 곳이 없으면 거부한다', () => {
    const path = scratchFile('sample.ts', 'export const a = 1;\n');
    expect(() => editFileTool(path, '없는 문자열', 'x')).toThrow();
  });

  test('여러 곳과 일치하면 거부한다', () => {
    // 어느 것을 바꿀지 알 수 없는 채로 수정하면 안 된다
    const path = scratchFile('sample.ts', 'const a = 1;\nconst b = 1;\n');
    expect(() => editFileTool(path, '= 1;', '= 2;')).toThrow();
  });

  test('읽지 않은 파일은 수정할 수 없다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'newbie-edit-'));
    dirs.push(dir);
    const path = join(dir, 'unread.ts');
    writeFileSync(path, 'export const a = 1;\n', 'utf8');

    expect(() => editFileTool(path, 'const a = 1;', 'const a = 2;')).toThrow();
  });
});
