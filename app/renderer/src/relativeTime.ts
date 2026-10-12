/**
 * 메시지 아래에 붙는 상대 시각 ("지금", "3분 전", "어제"가 아니라 "1일 전").
 *
 * now를 인자로 받는다 — 화면은 공용 시계(useClock)로 30초마다 한 박자로 다시
 * 그리고, 테스트는 고정된 now로 결정적으로 검사한다.
 */
export function formatRelativeTime(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return '지금';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}일 전`;
  const date = new Date(time);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}
