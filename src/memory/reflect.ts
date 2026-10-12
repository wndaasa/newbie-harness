import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dateStamp, readCheckinFile } from './checkin.ts';
import { getCheckinsBaseDir } from './paths.ts';

// 리플렉션 톤 규칙: 판정·진단 금지, 부정 프레이밍
// 금지. 수치와 경향만 제시하고 해석은 사용자에게 남긴다.
//
// 리포트는 앱에서도 그대로 쓰인다. system 행은 마크다운을 거치지 않고
// `white-space: pre-wrap`인 비례 글꼴로 그려지므로(app/renderer/src/styles.css의
// .row / .row-system), 자리맞춤으로 열을 맞추지 않는다. 값 구분은 공백이 아니라
// 기호(·, →)로 한다.

export type DailyMood = {
  date: string; // YYYY-MM-DD
  mood: number;
  tags: string[];
};

export type TagDiff = {
  tag: string;
  withAvg: number;
  withoutAvg: number;
  diff: number;
  withCount: number;
};

export type WeekdayAvg = {
  weekday: string;
  avg: number;
  count: number;
};

const DEFAULT_WINDOW_DAYS = 90;
const MIN_DAYS_FOR_REFLECTION = 7;
const TREND_DAYS = 14;
// 태그 diff는 양쪽 표본이 이 값 미만이면 우연일 가능성이 높아 제외
const MIN_TAG_SAMPLE = 2;

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// 모든 월 파일을 읽어 날짜별로 축약. 기분은 그날 마지막으로 기록된 항목이
// 이기고(스펙의 "하루 1개, 덮어쓰기" 의미 보존), 태그는 그날 항목들의 합집합.
export function collectDailyMoods(
  windowDays: number = DEFAULT_WINDOW_DAYS,
): DailyMood[] {
  const dir = getCheckinsBaseDir();
  if (!existsSync(dir)) return [];

  // 구간 필터는 로컬 날짜 문자열끼리 비교한다. entry.date는 로컬 기준
  // YYYY-MM-DD인데 Date.parse는 그것을 UTC 자정으로 읽어, 로컬 기준 now와
  // 섞어 비교하면 시간대만큼 경계일이 어긋난다(KST면 하루).
  const cutoff = dateStamp(new Date(Date.now() - windowDays * 86_400_000));

  const byDate = new Map<string, { mood: number; tags: Set<string> }>();

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  for (const file of files) {
    for (const entry of readCheckinFile(join(dir, file))) {
      if (entry.date < cutoff) continue;

      const current = byDate.get(entry.date);
      if (!current) {
        byDate.set(entry.date, { mood: entry.mood, tags: new Set(entry.tags) });
        continue;
      }

      // "그날의 값"은 append 순서상 마지막 항목이다 — getTodayMood()와 같은
      // 규칙. ts 최대값으로 고르면 손으로 편집해 ts가 뒤집힌 파일에서 두 곳이
      // 갈라지고, 펫이 보여주는 오늘 기분과 리포트의 오늘 기분이 달라진다.
      // readCheckinFile은 append 순서를 보존하고, 한 날짜의 항목은 항상 같은
      // 월 파일에 있으므로 파일 간 순서는 문제되지 않는다.
      current.mood = entry.mood;
      for (const tag of entry.tags) current.tags.add(tag);
    }
  }

  return [...byDate.entries()]
    .map(([date, v]) => ({ date, mood: v.mood, tags: [...v.tags] }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 핵심 인사이트: 태그가 있던 날 vs 없던 날의 평균 기분 차이 (차이 큰 순)
export function computeTagDiffs(days: DailyMood[]): TagDiff[] {
  const allTags = new Set(days.flatMap(d => d.tags));
  const diffs: TagDiff[] = [];

  for (const tag of allTags) {
    const withMoods = days.filter(d => d.tags.includes(tag)).map(d => d.mood);
    const withoutMoods = days.filter(d => !d.tags.includes(tag)).map(d => d.mood);
    if (
      withMoods.length < MIN_TAG_SAMPLE ||
      withoutMoods.length < MIN_TAG_SAMPLE
    ) {
      continue;
    }

    const withAvg = round1(average(withMoods));
    const withoutAvg = round1(average(withoutMoods));
    diffs.push({
      tag,
      withAvg,
      withoutAvg,
      diff: round1(withAvg - withoutAvg),
      withCount: withMoods.length,
    });
  }

  return diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

export function computeWeekdayAvgs(days: DailyMood[]): WeekdayAvg[] {
  const buckets = new Map<number, number[]>();
  for (const day of days) {
    const [y, m, d] = day.date.split('-').map(Number);
    const weekday = new Date(y, m - 1, d).getDay(); // 로컬 기준 요일
    const bucket = buckets.get(weekday) ?? [];
    bucket.push(day.mood);
    buckets.set(weekday, bucket);
  }

  return [...buckets.entries()]
    .map(([weekday, moods]) => ({
      weekday: WEEKDAY_LABELS[weekday],
      avg: round1(average(moods)),
      count: moods.length,
    }))
    .sort(
      (a, b) =>
        WEEKDAY_LABELS.indexOf(a.weekday) - WEEKDAY_LABELS.indexOf(b.weekday),
    );
}

// mood 1~10 → 8단계 블록 문자. 최근 추이를 한 줄로 보여준다.
export function sparkline(moods: number[]): string {
  const blocks = '▁▂▃▄▅▆▇█';
  return moods
    .map(mood => {
      const clamped = Math.max(1, Math.min(10, mood));
      return blocks[Math.round(((clamped - 1) / 9) * 7)];
    })
    .join('');
}

export function buildReflectionReport(): string {
  const days = collectDailyMoods();

  if (days.length < MIN_DAYS_FOR_REFLECTION) {
    return [
      `아직 데이터가 모이는 중이에요. (기록 ${days.length}일 / 최소 ${MIN_DAYS_FOR_REFLECTION}일)`,
      '며칠 더 쌓이면 패턴을 보여드릴게요. 빠진 날이 있어도 괜찮아요.',
    ].join('\n');
  }

  const lines: string[] = [];
  const totalAvg = round1(average(days.map(d => d.mood)));
  lines.push(
    `최근 ${DEFAULT_WINDOW_DAYS}일 중 ${days.length}일 기록 · 평균 기분 ${totalAvg}/10`,
  );

  const recent = days.slice(-TREND_DAYS);
  lines.push(
    '',
    `최근 ${recent.length}일 흐름 (${recent[0].date} ~ ${recent[recent.length - 1].date})`,
    `  ${sparkline(recent.map(d => d.mood))}  평균 ${round1(average(recent.map(d => d.mood)))}`,
  );

  const tagDiffs = computeTagDiffs(days);
  if (tagDiffs.length > 0) {
    lines.push('', '태그가 있던 날과 없던 날의 기분 차이');
    for (const t of tagDiffs.slice(0, 6)) {
      const sign = t.diff > 0 ? '+' : '';
      lines.push(
        `  #${t.tag}: 있던 날 ${t.withAvg} (${t.withCount}일) · 없던 날 ${t.withoutAvg} → ${sign}${t.diff}`,
      );
    }
  }

  const weekdays = computeWeekdayAvgs(days);
  if (weekdays.length >= 3) {
    lines.push(
      '',
      '요일별 평균',
      `  ${weekdays.map(w => `${w.weekday} ${w.avg}`).join(' · ')}`,
    );
  }

  lines.push('', '숫자는 경향일 뿐이에요. 해석은 천천히, 당신 몫으로.');
  return lines.join('\n');
}
