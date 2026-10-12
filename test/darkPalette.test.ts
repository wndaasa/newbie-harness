// 다크 팔레트의 명도 관계를 고정한다.
//
// 색은 눈으로 보고 정하지만, 두 가지는 눈으로 못 잡는다 — 글자 대비비가 접근성
// 기준 아래로 떨어지는 것과, 창 배경(theme.ts)이 --bg-app과 어긋나 타이틀바만
// 밝게 뜨는 것. 팔레트를 다시 만질 때 그 둘을 여기서 걸러낸다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const root = join(import.meta.dir, '..');
const css = readFileSync(join(root, 'app/renderer/src/styles.css'), 'utf8');
const themeTs = readFileSync(join(root, 'app/renderer/src/theme.ts'), 'utf8');

/** :root[data-theme='dark'] 블록의 토큰만 읽는다 */
function darkTokens(): Record<string, string> {
  const start = css.indexOf(":root[data-theme='dark'] {");
  expect(start).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf('}', start));
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const tokens = darkTokens();

test('본문·흐린 글자가 배경 위에서 WCAG 기준을 넘는다', () => {
  // 본문은 AAA(7:1), 흐린 글자는 AA(4.5:1) 이상
  expect(contrast(tokens['--text'], tokens['--bg'])).toBeGreaterThanOrEqual(7);
  expect(contrast(tokens['--text'], tokens['--bg-app'])).toBeGreaterThanOrEqual(7);
  expect(contrast(tokens['--text-dim'], tokens['--bg'])).toBeGreaterThanOrEqual(4.5);
  expect(contrast(tokens['--text-dim'], tokens['--bg-sidebar'])).toBeGreaterThanOrEqual(4.5);
});

test('경계선이 배경에 녹지 않는다', () => {
  // 라이트 팔레트 주석에 있듯 1.36:1로는 카드가 배경에 녹아 구조가 사라진다.
  // 배경을 내릴 때 --border를 같이 내리지 않으면 여기서 걸린다
  expect(contrast(tokens['--border'], tokens['--bg'])).toBeGreaterThanOrEqual(1.4);
});

test('바탕이 표면보다 어둡다 (층 순서)', () => {
  const app = luminance(tokens['--bg-app']);
  expect(app).toBeLessThan(luminance(tokens['--bg']));
  expect(app).toBeLessThan(luminance(tokens['--bg-sidebar']));
  expect(luminance(tokens['--bg'])).toBeLessThan(luminance(tokens['--bg-hover']));
  expect(luminance(tokens['--bg-hover'])).toBeLessThan(luminance(tokens['--bg-active']));
});

test('창 배경·OS 버튼색이 --bg-app과 같은 값이다', () => {
  // 어긋나면 타이틀바만 다른 밝기로 떠서 창이 두 겹으로 보인다
  const match = themeTs.match(/dark:\s*\{\s*color:\s*'(#[0-9a-fA-F]{6})'/);
  expect(match?.[1]?.toLowerCase()).toBe(tokens['--bg-app'].toLowerCase());
});
