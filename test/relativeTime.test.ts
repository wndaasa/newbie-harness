// 메시지 아래 상대 시각 표시 회귀 테스트.

import { describe, expect, test } from 'bun:test';
import { formatRelativeTime } from '../app/renderer/src/relativeTime.ts';

const NOW = Date.parse('2026-08-21T12:00:00Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe('상대 시각', () => {
  test('방금은 "지금"', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('지금');
    expect(formatRelativeTime(ago(40), NOW)).toBe('지금');
  });

  test('분·시간·일 단위로 올라간다', () => {
    expect(formatRelativeTime(ago(60 * 3), NOW)).toBe('3분 전');
    expect(formatRelativeTime(ago(60 * 30), NOW)).toBe('30분 전');
    expect(formatRelativeTime(ago(3600 * 2), NOW)).toBe('2시간 전');
    expect(formatRelativeTime(ago(86400 * 3), NOW)).toBe('3일 전');
  });

  test('일주일이 넘으면 날짜', () => {
    expect(formatRelativeTime('2026-08-01T03:00:00Z', NOW)).toMatch(/^8월 1일$/);
  });

  test('미래 시각(시계 오차)은 "지금"으로, 깨진 값은 빈 문자열', () => {
    expect(formatRelativeTime(ago(-30), NOW)).toBe('지금');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});
