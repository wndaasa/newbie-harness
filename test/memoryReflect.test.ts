// /reflect 집계 회귀 테스트.
//
// 이 파일이 고정하는 세 가지는 집계가 틀리기 쉬운 지점이다.
//   1. 구간 필터를 로컬 날짜 문자열끼리 비교한다 (Date.parse의 UTC 해석 섞지 않음)
//   2. "그날의 값"은 append 순서상 마지막 항목 — getTodayMood()와 같은 규칙
//   3. 기록이 최소 일수 미만이면 수치를 아예 내지 않는다 (판정하지 않는다는 톤 규칙)

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `newbie-reflect-${process.pid}`);
const CHECKINS = join(HOME, 'memory', 'checkins');
process.env.NEWBIE_HOME = HOME;

const {
  buildReflectionReport,
  collectDailyMoods,
  computeTagDiffs,
  computeWeekdayAvgs,
  sparkline,
} = await import('../src/memory/reflect.ts');

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

// 소비자와 같은 프레임(로컬)으로 날짜를 만든다. 테스트가 UTC 기준으로 날짜를
// 만들면 경계 검사가 시간대에 따라 통과했다 말았다 한다.
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

type Line = { date: string; mood: number; tags?: string[]; ts?: string };

// 월 파일로 나눠 쓴다 — 실제 저장 구조와 같게 두어야 여러 파일을 읽는 경로가 검증된다
function writeCheckins(lines: Array<Line | string>): void {
  rmSync(CHECKINS, { recursive: true, force: true });
  mkdirSync(CHECKINS, { recursive: true });

  const byMonth = new Map<string, string[]>();
  for (const line of lines) {
    if (typeof line === 'string') {
      // 손상된 줄은 그달 파일에 그대로 섞는다
      const month = byMonth.get('raw') ?? [];
      month.push(line);
      byMonth.set('raw', month);
      continue;
    }
    const month = line.date.slice(0, 7);
    const bucket = byMonth.get(month) ?? [];
    bucket.push(
      JSON.stringify({
        ts: line.ts ?? `${line.date}T09:00:00.000Z`,
        date: line.date,
        mood: line.mood,
        tags: line.tags ?? [],
        note: '',
      }),
    );
    byMonth.set(month, bucket);
  }

  for (const [month, bucket] of byMonth) {
    const name = month === 'raw' ? '9999-01.jsonl' : `${month}.jsonl`;
    writeFileSync(join(CHECKINS, name), bucket.join('\n') + '\n', 'utf8');
  }
}

beforeEach(() => writeCheckins([]));

describe('collectDailyMoods', () => {
  test('하루에 여러 번 기록되면 마지막 항목이 그날의 값', () => {
    writeCheckins([
      { date: daysAgo(1), mood: 3, tags: ['아침'] },
      { date: daysAgo(1), mood: 8, tags: ['저녁'] },
    ]);

    const days = collectDailyMoods();
    expect(days).toHaveLength(1);
    expect(days[0].mood).toBe(8);
  });

  test('ts가 뒤집혀 있어도 append 순서를 따른다 (getTodayMood와 같은 규칙)', () => {
    const date = daysAgo(1);
    writeCheckins([
      { date, mood: 3, ts: `${date}T23:00:00.000Z` },
      { date, mood: 8, ts: `${date}T01:00:00.000Z` },
    ]);

    expect(collectDailyMoods()[0].mood).toBe(8);
  });

  test('그날의 태그는 항목들의 합집합', () => {
    const date = daysAgo(1);
    writeCheckins([
      { date, mood: 5, tags: ['일', '혼자'] },
      { date, mood: 6, tags: ['일', '야근'] },
    ]);

    expect(collectDailyMoods()[0].tags.sort()).toEqual(['야근', '일', '혼자']);
  });

  test('구간 경계: 90일 전은 포함, 91일 전은 제외', () => {
    writeCheckins([
      { date: daysAgo(91), mood: 1 },
      { date: daysAgo(90), mood: 2 },
      { date: daysAgo(0), mood: 3 },
    ]);

    expect(collectDailyMoods().map(d => d.mood)).toEqual([2, 3]);
  });

  test('깨진 줄과 스키마 위반 줄은 건너뛴다', () => {
    writeCheckins([
      { date: daysAgo(2), mood: 7 },
      '{"ts":"x","date":"',
      '{"ts":"x","date":"2026-01-01","mood":"7","tags":[],"note":""}',
      '{"ts":"x","date":"2026-01-02","mood":11,"tags":[],"note":""}',
    ]);

    expect(collectDailyMoods(100_000).map(d => d.mood)).toEqual([7]);
  });

  test('체크인 디렉터리가 없으면 빈 배열', () => {
    rmSync(CHECKINS, { recursive: true, force: true });
    expect(collectDailyMoods()).toEqual([]);
  });
});

describe('computeTagDiffs', () => {
  const days = [
    { date: '2026-01-01', mood: 4, tags: ['야근'] },
    { date: '2026-01-02', mood: 4, tags: ['야근'] },
    { date: '2026-01-03', mood: 8, tags: ['휴식'] },
    { date: '2026-01-04', mood: 8, tags: ['휴식'] },
    { date: '2026-01-05', mood: 6, tags: ['한번뿐'] },
  ];

  test('있던 날과 없던 날의 평균 차이를 낸다', () => {
    const night = computeTagDiffs(days).find(d => d.tag === '야근');
    expect(night).toEqual({
      tag: '야근',
      withAvg: 4,
      withoutAvg: 7.3,
      diff: -3.3,
      withCount: 2,
    });
  });

  test('한쪽 표본이 2일 미만인 태그는 제외', () => {
    expect(computeTagDiffs(days).map(d => d.tag)).not.toContain('한번뿐');
  });

  test('차이의 절댓값이 큰 순으로 정렬', () => {
    const diffs = computeTagDiffs([
      ...days,
      { date: '2026-01-06', mood: 7, tags: ['야근', '작음'] },
      { date: '2026-01-07', mood: 6, tags: ['작음'] },
    ]);
    const magnitudes = diffs.map(d => Math.abs(d.diff));
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a));
  });
});

describe('computeWeekdayAvgs', () => {
  test('로컬 기준 요일로 묶어 평균을 낸다', () => {
    // 2026-01-01은 목요일
    const avgs = computeWeekdayAvgs([
      { date: '2026-01-01', mood: 4, tags: [] },
      { date: '2026-01-08', mood: 6, tags: [] },
      { date: '2026-01-02', mood: 9, tags: [] },
    ]);

    expect(avgs).toEqual([
      { weekday: '목', avg: 5, count: 2 },
      { weekday: '금', avg: 9, count: 1 },
    ]);
  });
});

describe('sparkline', () => {
  test('1은 가장 낮은 블록, 10은 가장 높은 블록', () => {
    expect(sparkline([1, 10])).toBe('▁█');
  });

  test('범위 밖 값도 양 끝으로 눌러 담는다', () => {
    expect(sparkline([-5, 99])).toBe('▁█');
  });
});

describe('buildReflectionReport', () => {
  test('기록이 7일 미만이면 수치를 내지 않고 안내만 한다', () => {
    writeCheckins([1, 2, 3, 4, 5, 6].map(n => ({ date: daysAgo(n), mood: 5 })));

    const report = buildReflectionReport();
    expect(report).toContain('아직 데이터가 모이는 중');
    expect(report).toContain('기록 6일 / 최소 7일');
    expect(report).not.toContain('평균 기분');
  });

  test('7일 이상이면 평균·추이·요일을 내고 해석은 남겨 둔다', () => {
    writeCheckins(
      [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({
        date: daysAgo(n),
        mood: 6,
        tags: n % 2 === 0 ? ['야근'] : ['휴식'],
      })),
    );

    const report = buildReflectionReport();
    expect(report).toContain('8일 기록 · 평균 기분 6/10');
    expect(report).toContain('최근 8일 흐름');
    expect(report).toContain('태그가 있던 날과 없던 날의 기분 차이');
    expect(report).toContain('요일별 평균');
    expect(report).toContain('숫자는 경향일 뿐이에요. 해석은 천천히, 당신 몫으로.');
  });

  test('열을 공백으로 맞추지 않는다 — 앱의 system 행은 비례 글꼴이다', () => {
    writeCheckins(
      [1, 2, 3, 4, 5, 6, 7].map(n => ({ date: daysAgo(n), mood: 6, tags: ['일'] })),
    );

    for (const line of buildReflectionReport().split('\n')) {
      // 들여쓰기 2칸과 스파크라인 뒤 2칸은 의도된 여백이다. 그보다 긴 공백은
      // padStart/padEnd로 열을 맞췄다는 뜻이고, 그 정렬은 앱에서 무너진다.
      expect(line).not.toMatch(/ {3}/);
    }
  });
});
