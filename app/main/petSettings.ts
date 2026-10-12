// 펫 설정(~/.newbie/pet.json). 펫 프로세스와 본앱 설정 탭이 같은 파일을 읽고 쓴다.
//
// preferences.json에 섞지 않는다 — 그 파일은 모델에게 보내는 값만 담는다는
// 전제로 시스템 프롬프트에 들어간다. 펫 설정은 모델과 무관한 화면 동작이다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getNewbieHome } from '../../src/memory/globalNewbie.ts';

export type QuietHours = { start: string; end: string };

export type PetPosition = { x: number; y: number };

/**
 * 플립북 시퀀스 두 개. idle은 걷지 않을 때 늘 넘기고, walk는 떠돌기로 걷는 동안만
 * 넘긴다. walk가 비면 걷는 동안에도 idle을 넘긴다
 */
export const PET_ANIMATION_SLOTS = ['idle', 'walk'] as const;
export type PetAnimationSlot = (typeof PET_ANIMATION_SLOTS)[number];

export function isPetAnimationSlot(value: unknown): value is PetAnimationSlot {
  return PET_ANIMATION_SLOTS.includes(value as PetAnimationSlot);
}

/** 시퀀스 하나. 낱장(frames)과 시트(sheet) 중 하나만 쓴다 — 시트가 있으면 시트 */
export type PetAnimation = {
  /** 차례로 넘길 이미지들의 절대 경로. 파일 이름 순 */
  frames: string[];
  /** 프레임을 격자로 모은 이미지 한 장의 절대 경로 */
  sheet: string;
  sheetColumns: number;
  sheetRows: number;
  /** 한 장을 보여 주는 시간(ms) */
  frameMs: number;
};

export type PetSettings = {
  /** 본앱 시작 시 펫을 함께 띄울지. 펫의 ✕도 이 값을 끈다 */
  enabled: boolean;
  /** /distill이 만든 확인 질문을 펫이 물어볼지. 꺼도 체크인 권유는 그대로다 */
  askQuestions: boolean;
  /** 오늘 체크인이 없을 때 기분을 물을지. 꺼도 CLI /checkin은 그대로다 */
  askCheckin: boolean;
  intervalMinutes: number;
  /** 시작과 끝이 같으면 조용한 시간 없음 */
  quietHours: QuietHours;
  /** 사용자가 고른 펫 이미지의 절대 경로. 비면 기본 얼굴 */
  image: string;
  /** 스스로 화면을 옆으로 걸어 다닐지 */
  roam: boolean;
  /** 플립북 시퀀스. 오른쪽을 보는 그림 기준 — 왼쪽으로 걸을 때 뒤집는다 */
  animations: Record<PetAnimationSlot, PetAnimation>;
  /** 마지막으로 옮겨 둔 창 위치(DIP). null이면 우하단 기본 위치 */
  position: PetPosition | null;
};

export const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: false,
  askQuestions: true,
  askCheckin: true,
  intervalMinutes: 60,
  quietHours: { start: '23:00', end: '08:00' },
  image: '',
  roam: false,
  animations: { idle: emptyAnimation(), walk: emptyAnimation() },
  position: null,
};

function emptyAnimation(): PetAnimation {
  return { frames: [], sheet: '', sheetColumns: 4, sheetRows: 4, frameMs: 140 };
}

/** 한 번에 읽어 data URL로 넘기므로 장수를 묶어 둔다 */
export const MAX_FRAMES = 24;
const MIN_FRAME_MS = 40;
const MAX_FRAME_MS = 1000;
/** 시트 한 변의 최대 칸 수. 16×16이면 256장이다 */
export const MAX_SHEET_CELLS = 16;

/**
 * 이펙트 에셋은 파일 이름에 격자를 적어 두는 일이 많다(Cloud02_8x8.png).
 * 시트를 고를 때 칸 수를 여기서 먼저 채운다. 못 읽으면 null
 */
export function guessSheetGrid(fileName: string): { columns: number; rows: number } | null {
  const match = /(?:^|\D)(\d{1,2})\s*[xX×]\s*(\d{1,2})(?!\d)/.exec(fileName);
  if (!match) return null;
  const columns = Number(match[1]);
  const rows = Number(match[2]);
  if (columns < 1 || rows < 1 || columns > MAX_SHEET_CELLS || rows > MAX_SHEET_CELLS) return null;
  return { columns, rows };
}

function sheetCells(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_SHEET_CELLS, Math.max(1, Math.round(value)))
    : fallback;
}

export function getPetSettingsPath(): string {
  return join(getNewbieHome(), 'pet.json');
}

/** 떠 있는 펫의 pid. 본앱이 실행 여부를 보여 주는 데 쓴다 */
export function getPetPidPath(): string {
  return join(getNewbieHome(), 'pet.pid');
}

const HHMM = /^\d{1,2}:\d{2}$/;

export function loadPetSettings(): PetSettings {
  try {
    return sanitize(JSON.parse(readFileSync(getPetSettingsPath(), 'utf8')));
  } catch {
    // 파일이 없거나 깨졌다고 펫이 못 뜨면 안 된다. 기본값으로 간다
    return { ...DEFAULT_PET_SETTINGS };
  }
}

export function savePetSettings(patch: Partial<PetSettings>): PetSettings {
  const next = sanitize({ ...loadPetSettings(), ...patch });
  const path = getPetSettingsPath();
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** 시퀀스 하나만 고친다. 넘긴 키만 바뀌고 다른 시퀀스는 그대로다 */
export function savePetAnimation(
  slot: PetAnimationSlot,
  patch: Partial<PetAnimation>,
): PetSettings {
  const { animations } = loadPetSettings();
  return savePetSettings({
    animations: { ...animations, [slot]: { ...animations[slot], ...patch } },
  });
}

function sanitizeAnimation(raw: unknown): PetAnimation {
  const parsed = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fallback = emptyAnimation();
  return {
    frames: Array.isArray(parsed.frames)
      ? parsed.frames
          .filter((frame): frame is string => typeof frame === 'string' && frame !== '')
          .slice(0, MAX_FRAMES)
      : [],
    sheet: typeof parsed.sheet === 'string' ? parsed.sheet : '',
    sheetColumns: sheetCells(parsed.sheetColumns, fallback.sheetColumns),
    sheetRows: sheetCells(parsed.sheetRows, fallback.sheetRows),
    frameMs:
      typeof parsed.frameMs === 'number' && Number.isFinite(parsed.frameMs)
        ? Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, Math.round(parsed.frameMs)))
        : fallback.frameMs,
  };
}

// 시퀀스가 하나이던 때의 필드(walkFrames, walkSheet…)를 읽는다. 그때 시트는 늘
// 넘겼고 낱장은 걸을 때만 넘겼으므로, 보이던 모습 그대로 시트는 idle로, 낱장은
// walk로 옮긴다
function legacyAnimations(parsed: Record<string, unknown>): Record<string, unknown> {
  const frameMs = parsed.walkFrameMs;
  return {
    idle: {
      sheet: parsed.walkSheet,
      sheetColumns: parsed.walkSheetColumns,
      sheetRows: parsed.walkSheetRows,
      frameMs,
    },
    walk: { frames: parsed.walkFrames, frameMs },
  };
}

function sanitize(raw: unknown): PetSettings {
  const parsed = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const quiet = parsed.quietHours as Partial<QuietHours> | undefined;
  const position = parsed.position as Partial<PetPosition> | null | undefined;
  const animations = (
    parsed.animations && typeof parsed.animations === 'object'
      ? parsed.animations
      : legacyAnimations(parsed)
  ) as Record<string, unknown>;
  return {
    enabled: parsed.enabled === true,
    // 필드가 없던 예전 파일은 켜진 것으로 본다 — 그동안 항상 물어봤다
    askQuestions: parsed.askQuestions !== false,
    askCheckin: parsed.askCheckin !== false,
    intervalMinutes:
      typeof parsed.intervalMinutes === 'number' &&
      Number.isFinite(parsed.intervalMinutes) &&
      parsed.intervalMinutes >= 1
        ? Math.round(parsed.intervalMinutes)
        : DEFAULT_PET_SETTINGS.intervalMinutes,
    quietHours:
      typeof quiet?.start === 'string' &&
      typeof quiet?.end === 'string' &&
      HHMM.test(quiet.start) &&
      HHMM.test(quiet.end)
        ? { start: quiet.start, end: quiet.end }
        : { ...DEFAULT_PET_SETTINGS.quietHours },
    image: typeof parsed.image === 'string' ? parsed.image : '',
    // 움직이는 펫은 시선을 끈다. 켜 둔 사람만 걷는다
    roam: parsed.roam === true,
    animations: {
      idle: sanitizeAnimation(animations.idle),
      walk: sanitizeAnimation(animations.walk),
    },
    position:
      typeof position?.x === 'number' &&
      typeof position?.y === 'number' &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
        ? { x: Math.round(position.x), y: Math.round(position.y) }
        : null,
  };
}
