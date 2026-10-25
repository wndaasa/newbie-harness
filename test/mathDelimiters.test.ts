// 수식 구분자 변환 회귀 테스트.
//
// 모델이 내는 \(...\)·\[...\] 구분자는 CommonMark에서 백슬래시 이스케이프로
// 먹혀 수식이 본문으로 깨진다. remark-math가 인식하는 달러 두 개(D) 구분자로 바꾸되,
// 코드 블록·인라인 코드 안의 LaTeX 예제는 원문 그대로 보존해야 한다.
// 달러 하나는 remark-math에서 껐으므로 금액이 둘 나오는 문장이 수식으로 깨지면 안 된다.

import { describe, expect, test } from 'bun:test';
import { normalizeMathDelimiters } from '../app/renderer/src/mathDelimiters.ts';

/** 달러 두 개. 소스에 그대로 쓰면 편집 도구가 하나로 줄여 저장한 적이 있어 상수로 둔다 */
const D = '\u0024\u0024';

describe('구분자 변환', () => {
  test('인라인 수식 \\(...\\) → 달러 두 개', () => {
    expect(normalizeMathDelimiters('크기 \\(\\epsilon_\\theta(x_t,t,c)\\) 입니다')).toBe(
      `크기 ${D}\\epsilon_\\theta(x_t,t,c)${D} 입니다`,
    );
  });

  test('모델이 쓴 달러 하나 인라인 수식은 달러 두 개로 바꿔 계속 수식으로 그린다', () => {
    expect(normalizeMathDelimiters('넓이는 \u0024\\pi r^2\u0024 입니다')).toBe(`넓이는 ${D}\\pi r^2${D} 입니다`);
  });

  test('금액이 둘 나오는 문장은 수식으로 바꾸지 않는다', () => {
    const content = '비용 차이 $0.001은 잡음입니다. 1회차 $0.068, 2회차 $0.103이었습니다.';
    expect(normalizeMathDelimiters(content)).toBe(content);
    const usd = '추정 비용은 본 측정 약 $3.1, 시험 실행 $0.43입니다.';
    expect(normalizeMathDelimiters(usd)).toBe(usd);
  });

  test('이미 달러 두 개로 쓴 수식과 이스케이프한 \\$는 건드리지 않는다', () => {
    expect(normalizeMathDelimiters(`식 ${D}a+b${D} 끝`)).toBe(`식 ${D}a+b${D} 끝`);
    expect(normalizeMathDelimiters('\\$5와 \\$7')).toBe('\\$5와 \\$7');
  });

  test('블록 수식 \\[...\\] → $$...$$', () => {
    const result = normalizeMathDelimiters('\\[ E = mc^2 \\]');
    expect(result).toContain('$$');
    expect(result).toContain(' E = mc^2 ');
    expect(result).not.toContain('\\[');
  });

  test('여러 줄에 걸친 블록 수식도 변환한다', () => {
    const result = normalizeMathDelimiters('\\[\na = b\n+ c\n\\]');
    expect(result).toContain('a = b\n+ c');
    expect(result).not.toContain('\\[');
  });

  test('한 문단에 인라인·블록이 섞여 있어도 각각 변환한다', () => {
    const result = normalizeMathDelimiters('여기 \\(x\\)와 \\[y^2\\]가 있다');
    expect(result).toContain('$x$');
    expect(result).toContain('y^2');
    expect(result).not.toContain('\\(');
    expect(result).not.toContain('\\[');
  });
});

describe('코드 구간 보존', () => {
  test('펜스 코드 블록 안은 건드리지 않는다', () => {
    const content = '설명 \\(x\\)\n```latex\n\\[ E = mc^2 \\]\n```';
    const result = normalizeMathDelimiters(content);
    expect(result).toContain('$x$');
    expect(result).toContain('\\[ E = mc^2 \\]'); // 코드 안은 원문 유지
  });

  test('인라인 코드 안은 건드리지 않는다', () => {
    const content = '`\\(x\\)` 형식은 \\(y\\)로 렌더링된다';
    const result = normalizeMathDelimiters(content);
    expect(result).toContain('`\\(x\\)`');
    expect(result).toContain('$y$');
  });

  test('닫히지 않은 펜스(스트리밍 중)도 코드로 취급한다', () => {
    const content = '```\n\\[ 아직 닫히지 않음';
    expect(normalizeMathDelimiters(content)).toBe(content);
  });
});

describe('그 외 텍스트 불변', () => {
  test('수식 구분자가 없으면 원문 그대로', () => {
    const content = '가격은 $5이고 배열은 arr[0]을 씁니다';
    expect(normalizeMathDelimiters(content)).toBe(content);
  });

  test('빈 값', () => {
    expect(normalizeMathDelimiters('')).toBe('');
    expect(normalizeMathDelimiters(undefined as unknown as string)).toBe('');
  });
});
