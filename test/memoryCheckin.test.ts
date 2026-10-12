// 체크인 파싱·스키마 회귀 테스트.
//
// Number()는 0x7·7e0·+7·7.0을 전부 7로 만든다. 메모 첫 단어가 우연히 숫자 표기로
// 읽히면 기분값으로 빨려 들어가고, 기분 데이터는 /reflect의 유일한 입력이라
// 조용한 오염이 된다. 읽기 경로도 같은 정의(isValidMood)를 공유한다.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = join(tmpdir(), `newbie-checkin-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

const {
  getTodayMood,
  hasTodayCheckin,
  isCheckinEntry,
  isValidMood,
  parseCheckinArgs,
  readCheckinFile,
} = await import('../src/memory/checkin.ts');

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe('parseCheckinArgs', () => {
  test.each([
    ['7', 7],
    ['1', 1],
    ['10', 10],
    ['7 #일 #혼자 야근 끝', 7],
  ])('유효한 기분 %p', (input, mood) => {
    expect(parseCheckinArgs(input)?.mood).toBe(mood);
  });

  test.each(['0x7', '7e0', '+7', '7.0', '07', '0', '11', '-1', '', 'seven', '7abc', ' '])(
    '거부: %p',
    input => expect(parseCheckinArgs(input)).toBeNull(),
  );

  test('태그와 메모 파싱은 그대로 동작한다', () => {
    expect(parseCheckinArgs('7 #일 #혼자 야근 끝')).toEqual({
      mood: 7,
      tags: ['일', '혼자'],
      note: '야근 끝',
    });
  });
});

describe('isValidMood', () => {
  test.each([
    [1, true],
    [10, true],
    [0, false],
    [11, false],
    [7.5, false],
    ['7', false],
    [null, false],
    [undefined, false],
    [Number.NaN, false],
  ])('isValidMood(%p) === %p', (value, ok) => {
    expect(isValidMood(value)).toBe(ok);
  });
});

describe('isCheckinEntry', () => {
  const base = { ts: '2026-08-12T00:00:00.000Z', date: '2026-08-12', mood: 7, tags: [], note: '' };

  test.each([
    [base, true],
    [{ ...base, tags: ['일'] }, true],
    [{ ts: base.ts, date: base.date, mood: 7 }, false], // tags/note 누락
    [{ ...base, tags: null }, false],
    [{ ...base, tags: [1] }, false],
    [{ ...base, mood: 0 }, false], // 범위 밖
    [{ ...base, mood: '7' }, false],
    [{ ...base, note: null }, false],
    [null, false],
    ['문자열', false],
  ])('isCheckinEntry(%p) === %p', (value, ok) => {
    expect(isCheckinEntry(value)).toBe(ok);
  });
});

test('손상된 줄이 섞여도 유효한 엔트리는 전부 읽힌다', () => {
  const path = join(HOME, 'checkins', '2026-08.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  const valid = { ts: '2026-08-12T00:00:00.000Z', date: '2026-08-12', mood: 7, tags: [], note: '' };
  writeFileSync(
    path,
    [
      JSON.stringify(valid),
      '{깨진 JSON',
      JSON.stringify({ ts: valid.ts, date: valid.date, mood: 7 }), // 필드 누락
      JSON.stringify({ ...valid, mood: 8 }),
      '',
    ].join('\n'),
    'utf8',
  );

  const entries = readCheckinFile(path);
  expect(entries).toHaveLength(2);
  expect(entries.map(e => e.mood)).toEqual([7, 8]);
});

// 펫 표정이 읽는 값 — 잘못되면 얼굴이 어제 기분에 멈추거나, 체크인을 했는데도
// 무표정으로 남아 사용자가 기록이 안 된 줄 안다.
describe('getTodayMood', () => {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const today = `${now.getFullYear()}-${mm}-${dd}`;
  // getCheckinMonthPath()와 같은 자리여야 한다 — 여기가 어긋나면 테스트가
  // 빈 파일을 읽고 전부 null로 통과해 버린다
  const monthPath = join(HOME, 'memory', 'checkins', `${now.getFullYear()}-${mm}.jsonl`);

  const entry = (date: string, mood: number) =>
    JSON.stringify({ ts: `${date}T00:00:00.000Z`, date, mood, tags: [], note: '' });

  const writeLines = (lines: string[]) => {
    mkdirSync(dirname(monthPath), { recursive: true });
    writeFileSync(monthPath, lines.join('\n'), 'utf8');
  };

  test('기록이 없으면 null이고 hasTodayCheckin도 false다', () => {
    writeLines([]);
    expect(getTodayMood()).toBeNull();
    expect(hasTodayCheckin()).toBe(false);
  });

  test('오늘 기록이 여러 개면 마지막 값이 그날의 기분이다', () => {
    writeLines([entry(today, 3), entry(today, 9)]);
    expect(getTodayMood()).toBe(9);
  });

  test('다른 날짜 기록은 오늘 값으로 새지 않는다', () => {
    writeLines([entry('2026-08-01', 10), entry(today, 4), entry('2026-08-02', 1)]);
    expect(getTodayMood()).toBe(4);
  });

  test('오늘 기록이 없으면 지난 기록이 있어도 null이다', () => {
    writeLines([entry('2026-08-01', 8)]);
    expect(getTodayMood()).toBeNull();
    expect(hasTodayCheckin()).toBe(false);
  });

  test('손상된 줄은 건너뛰고 유효한 마지막 값을 쓴다', () => {
    writeLines([entry(today, 7), '{깨진 JSON', entry(today, 2)]);
    expect(getTodayMood()).toBe(2);
  });
});
