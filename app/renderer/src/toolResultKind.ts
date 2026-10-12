/*
 * 도구 결과를 고정폭(코드)으로 그릴지 본문 글꼴(문장)으로 그릴지 가른다.
 *
 * 왜 필요한가. 결과를 전부 <pre>로 그렸더니 "화면을 찍었습니다: ..." 같은
 * 한국어 안내 문장까지 고정폭이 됐다. Cascadia Mono에는 한글 글리프가 없어
 * 한글만 Pretendard로 떨어지고, 결국 한 줄 안에서 고정폭 영문과 비례폭 한글이
 * 섞여 보였다. 문장을 처음부터 본문 글꼴로 그리면 이 문제 자체가 없어진다.
 *
 * 판단을 틀리면 코드 쪽이 안전하다(정렬이 깨지는 쪽이 더 눈에 띈다). 그래서
 * 문장이라는 근거가 확실할 때만 문장으로 본다.
 */

/** 이보다 길면 안내 문장이 아니라 출력물로 본다 */
const PROSE_MAX_CHARS = 700;
/** 이보다 줄이 많으면 마찬가지 */
const PROSE_MAX_LINES = 8;

const HANGUL = /[가-힣]/;

/**
 * 코드·표 출력에서만 나오는 신호.
 * 세미콜론이나 괄호는 한국어 안내 문장에도 섞여 나오므로 쓰지 않는다.
 * (예: "백그라운드로 실행했습니다\n명령: cd site; bun run dev")
 */
const CODE_SHAPES: RegExp[] = [
  /^[[{]/, //            JSON으로 시작
  /^[ \t]+\S/m, //       들여쓰기된 줄 = 코드 블록
  /\S {3,}\S/, //        칸 맞춘 표 (PowerShell 출력 등)
  /\t/, //               탭 정렬
];

/** 문장으로 그려야 하는 결과인가 */
export function isProseResult(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > PROSE_MAX_CHARS) return false;
  if (trimmed.split('\n').length > PROSE_MAX_LINES) return false;
  // 한글이 없으면 애초에 글꼴이 갈릴 일이 없다. 굳이 건드리지 않는다
  if (!HANGUL.test(trimmed)) return false;
  return !CODE_SHAPES.some(shape => shape.test(trimmed));
}
