import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCheckinMonthPath } from './paths.ts';

// 기록 부담을 줄이려고 기분만 있어도 유효한 기록으로 받는다.
// 하루 여러 번 기록될 수 있으며, 소비자(리플렉션)는 날짜별 마지막 항목을 그날의
// 값으로 취급한다. 하루 한 값이되 나중 기록이 앞선 기록을 덮는 셈이다.
export type CheckinEntry = {
  ts: string; // ISO timestamp
  date: string; // YYYY-MM-DD
  mood: number; // 1~10 필수
  tags: string[];
  note: string;
};

export type ParsedCheckin = {
  mood: number;
  tags: string[];
  note: string;
};

// 로컬 기준 YYYY-MM-DD. 체크인의 date 필드와 월 파일 이름이 모두 이 프레임이라,
// 날짜를 문자열로 비교하는 소비자(리플렉션의 구간 필터)도 같은 정의를 써야 한다.
export function dateStamp(date: Date = new Date()): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

// 기분은 1~10 정수다. 이 정의는 파일 읽기 스키마 검증과 펫 IPC가 공유한다.
export function isValidMood(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
  );
}

// 10진 정수 표기만 허용한다. Number()는 0x7·7e0·+7·7.0을 전부 7로 만들어,
// 메모 첫 단어가 우연히 숫자 표기로 읽히면 기분값으로 빨려 들어간다.
// 정규식이 범위(1~10)까지 표현하므로 파싱 경로에서는 isValidMood가 불필요하다.
const MOOD_TOKEN_RE = /^(10|[1-9])$/;

// "7 #일 #혼자 야근 끝" → mood 7, tags [일, 혼자], note "야근 끝"
// 첫 토큰이 1~10 정수 표기가 아니면 null.
export function parseCheckinArgs(args: string): ParsedCheckin | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !MOOD_TOKEN_RE.test(tokens[0])) return null;

  const mood = Number(tokens[0]);

  const tags: string[] = [];
  const noteParts: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith('#') && token.length > 1) tags.push(token.slice(1));
    else noteParts.push(token);
  }

  return { mood, tags, note: noteParts.join(' ') };
}

export function appendCheckin(parsed: ParsedCheckin): CheckinEntry {
  const now = new Date();
  const entry: CheckinEntry = {
    ts: now.toISOString(),
    date: dateStamp(now),
    mood: parsed.mood,
    tags: parsed.tags,
    note: parsed.note,
  };

  const path = getCheckinMonthPath(now);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

// 파일에서 읽은 값은 아직 CheckinEntry가 아니다 — 경계에서 검증한 뒤에만 그렇게 부른다.
// checkins/*.jsonl은 사용자가 직접 열어볼 수 있는 평문 파일이라, 손상되거나 손으로
// 편집된 줄이 소비자(리플렉션의 태그 집계 등)를 죽이면 안 된다. 관대한 폴백
// (tags ?? [])은 손상된 데이터를 정상인 척 통과시키므로 넣지 않는다.
export function isCheckinEntry(value: unknown): value is CheckinEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.ts === 'string' &&
    typeof e.date === 'string' &&
    isValidMood(e.mood) &&
    Array.isArray(e.tags) &&
    e.tags.every(t => typeof t === 'string') &&
    typeof e.note === 'string'
  );
}

export function readCheckinFile(path: string): CheckinEntry[] {
  if (!existsSync(path)) return [];

  const entries: CheckinEntry[] = [];
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isCheckinEntry(parsed)) entries.push(parsed);
      } catch {
        // 깨진 라인은 건너뜀 — append-only 파일의 부분 손상이 전체를 막으면 안 됨
      }
    }
  } catch {
    return [];
  }
  return entries;
}

// 오늘의 기분. 기록이 없으면 null.
// 하루에 여러 번 기록될 수 있으므로 마지막 항목이 그날의 값이다(파일 상단의
// "하루 1개, 덮어쓰기 허용" 규약). readCheckinFile은 append 순서를 보존한다.
export function getTodayMood(): number | null {
  const today = dateStamp();
  let mood: number | null = null;
  for (const entry of readCheckinFile(getCheckinMonthPath())) {
    if (entry.date === today) mood = entry.mood;
  }
  return mood;
}

// "오늘 값이 있는가"의 정의는 하나여야 한다 — getTodayMood와 갈라지면
// 펫이 표정은 띄우면서 체크인을 또 묻는 상태가 생긴다.
export function hasTodayCheckin(): boolean {
  return getTodayMood() !== null;
}
