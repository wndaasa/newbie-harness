// pet.json 읽기·쓰기가 새 필드(체크인 권유, 창 위치)와 잘못된 값을 어떻게
// 다루는지 고정한다. 펫과 본앱 설정 탭이 같은 파일을 공유하므로, 한쪽이 쓴 값을
// 다른 쪽이 기본값으로 되돌리면 설정이 조용히 튄다.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `newbie-pet-settings-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

const { DEFAULT_PET_SETTINGS, getPetSettingsPath, loadPetSettings, savePetSettings } =
  await import('../app/main/petSettings.ts');

function reset() {
  rmSync(HOME, { recursive: true, force: true });
}

beforeEach(reset);
afterEach(reset);

test('파일이 없으면 기본값이고, 예전 파일은 체크인 권유가 켜진 것으로 본다', () => {
  expect(loadPetSettings()).toEqual(DEFAULT_PET_SETTINGS);

  mkdirSync(HOME, { recursive: true });
  writeFileSync(getPetSettingsPath(), JSON.stringify({ enabled: true, intervalMinutes: 30 }));
  const loaded = loadPetSettings();
  expect(loaded.askCheckin).toBe(true);
  expect(loaded.position).toBeNull();
  expect(loaded.intervalMinutes).toBe(30);
});

test('부분 저장은 나머지 값을 건드리지 않는다', () => {
  savePetSettings({ position: { x: 100, y: 200 }, intervalMinutes: 15 });
  const next = savePetSettings({ askCheckin: false });
  expect(next.askCheckin).toBe(false);
  expect(next.position).toEqual({ x: 100, y: 200 });
  expect(next.intervalMinutes).toBe(15);
  expect(loadPetSettings()).toEqual(next);
});

test('잘못된 값은 기본값으로 돌아간다', () => {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(
    getPetSettingsPath(),
    JSON.stringify({
      intervalMinutes: 0,
      quietHours: { start: '밤', end: '08:00' },
      position: { x: 'left', y: 10 },
    }),
  );
  const loaded = loadPetSettings();
  expect(loaded.intervalMinutes).toBe(DEFAULT_PET_SETTINGS.intervalMinutes);
  expect(loaded.quietHours).toEqual(DEFAULT_PET_SETTINGS.quietHours);
  expect(loaded.position).toBeNull();
});

test('위치를 비우면 기본 자리로 돌아간다', () => {
  savePetSettings({ position: { x: 10.6, y: 20.2 } });
  expect(loadPetSettings().position).toEqual({ x: 11, y: 20 });
  expect(savePetSettings({ position: null }).position).toBeNull();
});

test('떠돌기는 명시적으로 켠 경우에만 켜진다', () => {
  expect(loadPetSettings().roam).toBe(false);

  mkdirSync(HOME, { recursive: true });
  writeFileSync(getPetSettingsPath(), JSON.stringify({ roam: 'yes' }));
  expect(loadPetSettings().roam).toBe(false);

  expect(savePetSettings({ roam: true }).roam).toBe(true);
  expect(savePetSettings({ askCheckin: false }).roam).toBe(true);
});

test('시퀀스는 문자열 경로만 남기고 장수·속도·칸 수를 묶는다', async () => {
  const { savePetAnimation } = await import('../app/main/petSettings.ts');
  expect(loadPetSettings().animations).toEqual(DEFAULT_PET_SETTINGS.animations);

  mkdirSync(HOME, { recursive: true });
  writeFileSync(
    getPetSettingsPath(),
    JSON.stringify({
      animations: {
        idle: { frames: ['a.png', 3, '', null, 'b.png'], frameMs: 5 },
        walk: { sheet: 'walk.png', sheetColumns: 0, sheetRows: 99, frameMs: 'fast' },
      },
    }),
  );
  const loaded = loadPetSettings().animations;
  expect(loaded.idle.frames).toEqual(['a.png', 'b.png']);
  expect(loaded.idle.frameMs).toBe(40);
  expect(loaded.walk.sheetColumns).toBe(1);
  expect(loaded.walk.sheetRows).toBe(16);
  expect(loaded.walk.frameMs).toBe(DEFAULT_PET_SETTINGS.animations.walk.frameMs);

  const many = Array.from({ length: 30 }, (_, i) => `walk${i}.png`);
  expect(savePetAnimation('idle', { frames: many, frameMs: 99_999 }).animations.idle.frames).toHaveLength(24);
  expect(loadPetSettings().animations.idle.frameMs).toBe(1000);
});

test('한 시퀀스를 고쳐도 다른 시퀀스와 나머지 설정은 그대로다', async () => {
  const { savePetAnimation } = await import('../app/main/petSettings.ts');
  savePetSettings({ roam: true });
  savePetAnimation('idle', { sheet: 'flame.png', sheetColumns: 16, sheetRows: 4 });
  const next = savePetAnimation('walk', { frames: ['w1.png', 'w2.png'], frameMs: 90 });
  expect(next.roam).toBe(true);
  expect(next.animations.idle).toMatchObject({ sheet: 'flame.png', sheetColumns: 16, sheetRows: 4 });
  expect(next.animations.walk).toMatchObject({ frames: ['w1.png', 'w2.png'], frameMs: 90 });
});

test('시퀀스가 하나이던 때의 설정은 보이던 모습대로 옮긴다', () => {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(
    getPetSettingsPath(),
    JSON.stringify({
      walkFrames: ['w1.png', 'w2.png'],
      walkFrameMs: 100,
      walkSheet: 'cloud_8x8.png',
      walkSheetColumns: 8,
      walkSheetRows: 8,
    }),
  );
  const { idle, walk } = loadPetSettings().animations;
  // 그때 시트는 늘 넘겼다 → idle, 낱장은 걸을 때만 넘겼다 → walk
  expect(idle).toMatchObject({ sheet: 'cloud_8x8.png', sheetColumns: 8, sheetRows: 8, frameMs: 100 });
  expect(walk).toMatchObject({ frames: ['w1.png', 'w2.png'], frameMs: 100 });
});

test('파일 이름에서 시트 격자를 읽는다', async () => {
  const { guessSheetGrid } = await import('../app/main/petSettings.ts');
  expect(guessSheetGrid('Cloud02_8x8.png')).toEqual({ columns: 8, rows: 8 });
  expect(guessSheetGrid('Flame02_16x4.png')).toEqual({ columns: 16, rows: 4 });
  expect(guessSheetGrid('walk-6X2.png')).toEqual({ columns: 6, rows: 2 });
  expect(guessSheetGrid('run 4×3.png')).toEqual({ columns: 4, rows: 3 });
  expect(guessSheetGrid('walk.png')).toBeNull();
  expect(guessSheetGrid('huge_32x32.png')).toBeNull();
  expect(guessSheetGrid('photo_1920x1080.png')).toBeNull();
});
