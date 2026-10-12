// 이중 이스케이프 복구 회귀 테스트.
//
// 모델이 도구 인자를 JSON으로 만들 때 이스케이프를 두 번 적용하면, 파싱 후에도
// `\n`과 `\"`가 글자 그대로 남는다. 실제로 한 세션에서 파일 3개 중 2개가 이렇게
// 저장돼 index.html 전체가 한 줄이 됐다.
//
// 예전에는 이걸 거부하고 모델에게 다시 보내게 했는데, 그게 복구 불가능한
// 무한루프를 만들었다 — 모델이 큰 코드 파일을 이스케이프 없이 다시 보내는 데
// 반복 실패하다 결국 도구 호출을 포기하고 "만들겠습니다"만 반복하게 됐다.
// 그래서 거부 대신 되돌려서 저장하도록 바꿨다.

import { describe, expect, test } from 'bun:test';
import {
  isLikelyDoubleEscaped,
  repairDoubleEscaped,
} from '../src/tools/write/writeFile.ts';

// 실제로 저장됐던 내용의 앞부분
const BROKEN =
  '<!doctype html>\\n<html lang=\\"ko\\">\\n  <head>\\n    <meta charset=\\"UTF-8\\" />\\n' +
  '    <title>Focusly</title>\\n  </head>\\n  <body>\\n    <div id=\\"root\\"></div>\\n' +
  '  </body>\\n</html>\\n' +
  '<!-- 길이 조건을 넘기기 위한 여백입니다. 실제 파일은 이보다 훨씬 깁니다. -->';

describe('이중 이스케이프 판정', () => {
  test('실제로 깨졌던 내용을 잡는다', () => {
    expect(BROKEN.length).toBeGreaterThan(200);
    expect(isLikelyDoubleEscaped(BROKEN)).toBe(true);
  });
});

describe('이중 이스케이프 복구', () => {
  test('깨진 내용을 실제 줄바꿈·따옴표로 되돌린다', () => {
    const fixed = repairDoubleEscaped(BROKEN);
    // 진짜 줄바꿈이 생기고, 글자 그대로였던 `\n`은 사라진다
    expect(fixed).toContain('\n');
    expect(fixed).not.toContain('\\n');
    // `\"` → `"`
    expect(fixed).toContain('lang="ko"');
    expect(fixed).not.toContain('\\"');
  });

  test('역슬래시 이스케이프(`\\\\`)도 한 글자로 되돌린다', () => {
    const broken = `const p = "C:\\\\a\\\\b";\\n${'// 여백을 채워 길이 조건을 넘긴다. '.repeat(10)}\\nend`;
    const fixed = repairDoubleEscaped(broken);
    expect(fixed).toContain('C:\\a\\b');
    expect(fixed).toContain('\n');
  });
});

describe('오탐 방지 — 정상 내용은 그대로 둔다', () => {
  test('줄바꿈이 있는 정상 파일은 손대지 않는다', () => {
    const normal = `${'<!doctype html>\n<html>\n  <body>\n'.repeat(20)}</html>`;
    expect(isLikelyDoubleEscaped(normal)).toBe(false);
    expect(repairDoubleEscaped(normal)).toBe(normal);
  });

  test('문자열 안에 \\n을 담은 정상 코드는 손대지 않는다', () => {
    // 줄바꿈이 있으므로 이스케이프 문제가 아니다
    const code = `${'const a = "line1\\nline2";\n'.repeat(20)}`;
    expect(isLikelyDoubleEscaped(code)).toBe(false);
    expect(repairDoubleEscaped(code)).toBe(code);
  });

  test('짧은 한 줄짜리는 손대지 않는다', () => {
    const short = 'console.log("a\\nb");';
    expect(isLikelyDoubleEscaped(short)).toBe(false);
    expect(repairDoubleEscaped(short)).toBe(short);
  });

  test('길어도 \\n이 한 번뿐이면 손대지 않는다', () => {
    const oneLine = `const message = "hello\\nworld"; ${'// 여백 '.repeat(40)}`;
    expect(oneLine.length).toBeGreaterThan(200);
    expect(isLikelyDoubleEscaped(oneLine)).toBe(false);
    expect(repairDoubleEscaped(oneLine)).toBe(oneLine);
  });

  test('빈 값은 그대로 둔다', () => {
    expect(isLikelyDoubleEscaped('')).toBe(false);
    expect(repairDoubleEscaped('')).toBe('');
    expect(isLikelyDoubleEscaped(undefined as unknown as string)).toBe(false);
  });
});
