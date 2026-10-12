// topic slug 검증 회귀 테스트.
//
// slug는 LLM이 만들어 그대로 파일 이름이 된다. 정제 입력인 대화 로그에는
// web_fetch/read_file로 들어온 제3자 텍스트가 섞이므로 이름을 그대로 믿으면
// ~/.newbie/Newbie.md나 홈 밖 파일을 덮어쓸 수 있었다. 순수 함수라 파일 I/O 없이 덮인다.

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { isValidSlug, resolveInside } from '../src/memory/slug.ts';

describe('isValidSlug', () => {
  test.each([
    ['topic-name', true],
    ['a', true],
    ['a1-b2', true],
    ['../../Newbie', false],
    ['MEMORY', false],
    ['a/b', false],
    ['a\b', false],
    ['a..b', false],
    ['a b', false],
    ['-lead', false],
    ['trail-', false],
    ['UPPER', false],
    ['', false],
    ['a'.repeat(65), false],
  ])('isValidSlug(%p) === %p', (name, ok) => {
    expect(isValidSlug(name)).toBe(ok);
  });

  test('문자열이 아닌 값은 거부한다', () => {
    for (const value of [undefined, null, 7, {}, ['a']]) {
      expect(isValidSlug(value)).toBe(false);
    }
  });
});

describe('resolveInside', () => {
  test('기준 디렉터리 안의 파일은 절대 경로로 돌려준다', () => {
    expect(resolveInside('/base', 'x.md')).toBe(resolve('/base', 'x.md'));
  });

  test('기준 디렉터리를 벗어나는 경로는 거부한다', () => {
    // 심층 방어 — 형식 검사를 통과해도 여기서 한 번 더 막힌다
    expect(() => resolveInside('/base', '../x.md')).toThrow();
    expect(() => resolveInside('/base', '../../Newbie.md')).toThrow();
  });

  test('접두사만 같은 형제 디렉터리는 안쪽이 아니다', () => {
    expect(() => resolveInside('/base', '../based/x.md')).toThrow();
  });
});
