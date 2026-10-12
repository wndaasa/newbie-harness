import { useSyncExternalStore } from 'react';

// 테마 상태 저장·적용.
// 색 자체는 전부 styles.css의 CSS 변수(:root / [data-theme='dark'])가 갖고 있고,
// 여기서는 <html data-theme>만 갈아끼운다. 단 OS 창 버튼(titleBarOverlay)과
// 창 배경색은 CSS 밖이라 main 프로세스에 IPC로 함께 알린다.

export type ThemePreference = 'dark' | 'light' | 'system';

const THEME_KEY = 'newbie.theme';

// styles.css의 --bg-app과 반드시 같은 값이어야 함 (창 배경·OS 버튼 영역색)
const TITLEBAR_COLORS = {
  dark: { color: '#0e0e0e', symbolColor: '#b0b0b0' },
  light: { color: '#ffffff', symbolColor: '#54524a' },
} as const;

// 오버레이 합성색 위 창 버튼색 — 합성 결과의 밝기에 따라 선택
const SYMBOL_ON_LIGHT = '#2c2b26';
const SYMBOL_ON_DARK = '#efedf5';

let preference: ThemePreference = loadPreference();
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function loadPreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'dark' || stored === 'light' || stored === 'system'
    ? stored
    : 'system';
}

export function themePreference(): ThemePreference {
  return preference;
}

export function resolvedTheme(): 'dark' | 'light' {
  if (preference === 'system') return media.matches ? 'dark' : 'light';
  return preference;
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
}

function applyTheme() {
  const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  window.newbie.setThemeColors(TITLEBAR_COLORS[resolved]);
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, themePreference);
}

function useResolvedTheme(): 'dark' | 'light' {
  return useSyncExternalStore(subscribe, resolvedTheme);
}

/**
 * 전체 화면 오버레이 rgba × 현재 테마 앱 배경(--bg-app)의 합성색과,
 * 그 위에서 보이는 창 버튼색을 계산함 (useTitlebarShade에 넘길 값).
 * 테마가 바뀌면 재계산되도록 훅으로 제공한다.
 */
export function useOverlayTitlebarColors(
  r: number,
  g: number,
  b: number,
  alpha: number,
): { color: string; symbolColor: string } {
  useResolvedTheme();
  const bg = parseHex(
    getComputedStyle(document.documentElement).getPropertyValue('--bg-app'),
  );
  const mix = (overlay: number, base: number) =>
    Math.round(overlay * alpha + base * (1 - alpha));
  const [cr, cg, cb] = [mix(r, bg[0]), mix(g, bg[1]), mix(b, bg[2])];
  const luminance = (cr * 299 + cg * 587 + cb * 114) / 1000;
  return {
    color: `#${toHex(cr)}${toHex(cg)}${toHex(cb)}`,
    symbolColor: luminance > 140 ? SYMBOL_ON_LIGHT : SYMBOL_ON_DARK,
  };
}

function parseHex(value: string): [number, number, number] {
  const hex = value.trim().replace('#', '');
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

// OS 테마 변경 실시간 반영 (시스템 따라가기일 때만 실제로 바뀜)
media.addEventListener('change', () => {
  if (preference === 'system') applyTheme();
});

// 첫 페인트 전에 data-theme을 심어 라이트 팔레트가 번쩍이지 않게 함
applyTheme();
