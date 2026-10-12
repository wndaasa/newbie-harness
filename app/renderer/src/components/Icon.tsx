// 아이콘.
//
// 예전에는 ≡, ⋮, ⚙, ›, ⌄, ×, ● 같은 글자를 그대로 썼다. 글자라서 어느 글꼴이
// 잡히느냐에 따라 굵기와 크기가 제각각이었고, 톱니바퀴는 폼 요소 기본 글꼴인
// Arial로 떨어져 옆 한글과 전혀 안 맞았다. 확대해 보면 획이 가늘고 삐뚤어
// 보이는 것도 그 때문이다.
//
// 선 굵기와 크기를 한 곳에서 정하는 SVG로 바꾼다. currentColor를 쓰므로
// 색은 쓰는 쪽 글자색을 그대로 따라간다.

const STROKE = 1.6;
/**
 * 색이 꽉 찬 배경 위에 흰 아이콘을 얹으면 같은 굵기라도 가늘어 보인다
 * (밝은 획이 어두운 바탕에 먹힌다). 그런 자리는 이 굵기를 쓴다.
 */
const STROKE_ON_FILL = 2.1;

type IconProps = {
  size?: number;
  /** 접근성 이름. 버튼에 글자가 따로 없으면 지정할 것 */
  label?: string;
  /** 색이 꽉 찬 배경 위에 놓이는가 (전송·중단 버튼 등) */
  onFill?: boolean;
};

function Svg({
  children,
  label,
  onFill,
  size = 16,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className="icon"
      fill="none"
      height={size}
      role={label ? 'img' : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={onFill ? STROKE_ON_FILL : STROKE}
      viewBox="0 0 24 24"
      width={size}
    >
      {children}
    </svg>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function IconMore(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 5l7 7-7 7" />
    </Svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 9l7 7 7-7" />
    </Svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Svg>
  );
}

/** 복사. 겹친 네모 두 장 */
export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect height="12" rx="2" width="12" x="9" y="9" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </Svg>
  );
}

/*
 * 전송. 위로 향하는 화살표를 쓴다 — 오른쪽 화살표는 "다음"으로 읽힌다.
 *
 * 획과 촉의 꼭짓점 좌표를 (12, 6)으로 정확히 맞춘다. 예전에는 획이 x=18에서
 * 끝나는데 촉의 꼭짓점은 x=19라, 둘이 만나지 않고 홈이 파여 보였다.
 */
export function IconSend(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19V6" />
      <path d="M6.5 11.5L12 6l5.5 5.5" />
    </Svg>
  );
}

/* 중단. 예전 사각형은 24 기준 10이라 34px 원 안에서 점처럼 작아 보였다 */
export function IconStop(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="5" width="14" height="14" rx="3.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/* 채팅 탭 */
export function IconMessage(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
    </Svg>
  );
}

/* 코딩 탭 */
export function IconCode(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 17.5 3.5 12 9 6.5M15 6.5 20.5 12 15 17.5" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** 접힌 도구 항목에 "결과에 그림이 있다"를 알리는 표시 */
export function IconImage(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="8.5" cy="10" r="1.4" />
      <path d="M21 16l-4.5-4.5L7 21" />
    </Svg>
  );
}

/** 오류 행 머리의 표시. 색만으로 알리지 않기 위해 모양을 함께 둔다 */
export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.6 4.1 2.6 18a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4l-8-13.9a1.6 1.6 0 0 0-2.8 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

/** 실행 중 표시용 점. 선이 아니라 면이라 따로 둔다 */
export function IconDot({ size = 8 }: IconProps) {
  return (
    <svg aria-hidden className="icon" height={size} viewBox="0 0 8 8" width={size}>
      <circle cx="4" cy="4" fill="currentColor" r="4" />
    </svg>
  );
}
