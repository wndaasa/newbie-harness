/**
 * LaTeX 수식 구분자(\(...\), \[...\])를 remark-math가 인식하는 $ 구분자로 변환.
 *
 * 모델은 대개 \(...\)·\[...\] 형식으로 수식을 내는데, CommonMark에서 \[는
 * 대괄호의 백슬래시 이스케이프라 백슬래시가 사라지고 수식이 본문으로 깨진다.
 * remark-math는 $...$·$$...$$만 인식하므로 렌더링 전에 바꿔 준다.
 *
 * 코드 블록·인라인 코드 안의 LaTeX 예제는 건드리면 안 되므로, 코드 구간을
 * 통째로 잡아 보존하고 나머지 구간만 변환한다. 닫히지 않은 펜스((?:```|$))도
 * 코드로 취급한다 — 스트리밍 중에는 블록이 아직 닫히기 전 상태가 흔하다.
 */
export function normalizeMathDelimiters(content: string): string {
  const parts = String(content ?? '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/);
  return parts
    .map((part, index) => {
      // 홀수 인덱스가 캡처된 코드 구간
      if (index % 2 === 1) return part;
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => `\n$$\n${body}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => `$${body}$`);
    })
    .join('');
}
