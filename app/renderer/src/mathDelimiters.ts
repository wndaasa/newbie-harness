/**
 * 수식 구분자를 remark-math가 인식하는 달러 두 개 구분자(MATH)로 변환.
 *
 * 모델은 대개 \(...\)·\[...\] 형식으로 수식을 내는데, CommonMark에서 \[는
 * 대괄호의 백슬래시 이스케이프라 백슬래시가 사라지고 수식이 본문으로 깨진다.
 *
 * 달러 기호 하나($...$)는 remark-math에서 껐다(Markdown.tsx의 singleDollarTextMath).
 * 켜 두면 "$0.001 … $0.068"처럼 금액이 둘 나오는 문장에서 그 사이 전체가 수식으로
 * 그려져, 띄어쓰기가 사라진 이탤릭 글자로 깨졌다. 그래서 인라인 수식도 달러 두 개로
 * 감싸 넘긴다. 모델이 쓴 $x^2$는 Pandoc 규칙을 따를 때만 수식으로 본다 — 여는
 * $ 뒤가 공백·숫자가 아니고, 닫는 $ 앞이 공백이 아니며 뒤가 숫자가 아니고, 한 줄 안.
 * 금액($5, $0.068)은 여는 $ 뒤가 숫자라 그대로 글자로 남는다.
 *
 * 코드 블록·인라인 코드 안은 건드리면 안 되므로, 코드 구간을 통째로 잡아 보존하고
 * 나머지 구간만 변환한다. 닫히지 않은 펜스((?:```|$))도 코드로 취급한다 — 스트리밍
 * 중에는 블록이 아직 닫히기 전 상태가 흔하다.
 */
export function normalizeMathDelimiters(content: string): string {
  const parts = String(content ?? '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/);
  return parts
    .map((part, index) => {
      // 홀수 인덱스가 캡처된 코드 구간
      if (index % 2 === 1) return part;
      return part
        .replace(SINGLE_DOLLAR_MATH, (_, body) => MATH + body + MATH)
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => '\n' + MATH + '\n' + body + '\n' + MATH + '\n')
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => MATH + body + MATH);
    })
    .join('');
}

/** remark-math의 수식 구분자 (달러 두 개) */
const MATH = '\u0024\u0024';

/** Pandoc 규칙의 달러 하나 수식 (위 주석). 달러 두 개나 \$는 건드리지 않는다 */
const SINGLE_DOLLAR_MATH = /(?<![\\$])\$(?![\s\d$])([^$\n]*?[^\s\\$])\$(?![\d$])/g;
