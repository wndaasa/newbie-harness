// 펫 떠돌기 — 창을 스스로 옆으로 옮겨 걷게 한다 (pet.json의 roam).
//
// 걷는 그림은 따로 없다. 창이 움직이는 동안 렌더러가 이미지 한 장을 뒤뚱거리게
// 흔들어(#pet.walk) 걷는 것처럼 보이게 한다. 여기서는 언제 걷고 쉴지, 어디로
// 갈지만 정하고 'pet:motion'으로 알린다.
//
// 좌표는 main에서만 다룬다 — 드래그와 같은 이유로, 작업 영역과 setPosition의
// 단위(DIP)를 렌더러는 정확히 모른다.
import { screen, type BrowserWindow, type Rectangle } from 'electron';

const SPEED = 36; // px/s — 시선을 끌지 않게 느리게
const TICK_MS = 33;
const REST_MS: [number, number] = [4_000, 12_000];
const WALK_MS: [number, number] = [3_000, 8_000];
// 스스로 옮긴 직후 오는 'moved'는 사용자가 옮긴 게 아니다. 이 안에 온 것은 무시한다
const AUTO_MOVE_GRACE_MS = 500;

/**
 * 창을 옮긴다. setPosition을 쓰지 않는다 — 배율이 100%가 아닌 화면(150%에서 확인)에서
 * 투명 창에 setPosition을 할 때마다 창이 1px씩 커져, 300번 옮기면 240×320이
 * 482×623이 된다. 펫은 창 아래 가운데에 붙어 있어 창이 커지는 만큼 오른쪽 아래로
 * 밀려 화면 밖으로 나간다. 크기까지 매번 못 박으면 그대로다
 */
export function placeWindow(
  win: BrowserWindow,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
}

export type Roamer = {
  /** 방금 들어온 'moved'가 떠돌기 때문인지 */
  movedByRoam: () => boolean;
  stop: () => void;
};

type Options = {
  width: number;
  height: number;
  /** 드래그·말풍선·hover·설정 꺼짐 등 지금은 걸으면 안 되는지 */
  isHeld: () => boolean;
  /** 걷다 멈췄을 때. 끝난 자리를 기억하는 데 쓴다 */
  onRest: () => void;
};

function between([min, max]: [number, number]): number {
  return min + Math.random() * (max - min);
}

export function startRoaming(
  win: BrowserWindow,
  { width, height, isHeld, onRest }: Options,
): Roamer {
  let walking = false;
  let dir: 1 | -1 = 1;
  let until = Date.now() + between(REST_MS);
  let last = Date.now();
  // 걷는 동안 위치는 여기에만 둔다. getPosition을 매 틱 다시 읽으면 정수 반올림에
  // 이동량(1px 남짓)이 먹힌다
  let x = 0;
  let y = 0;
  // 걷기를 시작한 화면. 걷는 도중에 창과 가장 많이 겹치는 화면을 다시 고르면
  // 모니터 경계에서 기준이 옆 화면으로 넘어가 그대로 건너가 버린다
  let displayId = 0;
  let lastAutoMoveAt = 0;

  const send = () => {
    if (!win.isDestroyed()) win.webContents.send('pet:motion', { walking, dir });
  };

  const rest = () => {
    until = Date.now() + between(REST_MS);
    if (!walking) return;
    walking = false;
    send();
    onRest();
  };

  // 창 전체가 들어가는 좌상단 좌표 범위. 작업 영역이 창보다 작으면 왼쪽·위에 붙인다
  const bounds = ({ x: ax, y: ay, width: aw, height: ah }: Rectangle) => ({
    min: ax,
    max: Math.max(ax, ax + aw - width),
    top: ay,
    bottom: Math.max(ay, ay + ah - height),
  });

  // 걷는 도중 모니터가 빠지거나 배율이 바뀌면 그때 창이 걸친 화면으로 넘어간다
  const area = (): Rectangle => {
    const display =
      screen.getAllDisplays().find(d => d.id === displayId) ??
      screen.getDisplayMatching(win.getBounds());
    displayId = display.id;
    return display.workArea;
  };

  const walk = () => {
    [x, y] = win.getPosition();
    displayId = screen.getDisplayMatching(win.getBounds()).id;
    const { min, max } = bounds(area());
    // 벽 가까이에서 벽 쪽으로 출발하면 바로 돌아서서 어색하다. 넓은 쪽으로 간다
    dir = x - min < (max - min) / 4 ? 1 : max - x < (max - min) / 4 ? -1 : Math.random() < 0.5 ? 1 : -1;
    walking = true;
    until = Date.now() + between(WALK_MS);
    send();
  };

  const timer = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;

    if (isHeld()) {
      rest();
      return;
    }
    if (now >= until) {
      if (walking) rest();
      else walk();
      return;
    }
    if (!walking) return;

    const { min, max, top, bottom } = bounds(area());
    x += dir * SPEED * dt;
    if (x <= min || x >= max) {
      x = Math.max(min, Math.min(max, x));
      dir = dir === 1 ? -1 : 1;
      send();
    }
    // 옆으로만 간다 — 사용자가 올려 둔 높이는 그대로 두되, 화면에 걸쳐 있던
    // 창이면 걷기 시작할 때 안으로 들인다
    y = Math.max(top, Math.min(bottom, y));
    lastAutoMoveAt = now;
    placeWindow(win, x, y, width, height);
  }, TICK_MS);

  return {
    movedByRoam: () => Date.now() - lastAutoMoveAt < AUTO_MOVE_GRACE_MS,
    stop: () => {
      clearInterval(timer);
      rest();
    },
  };
}
