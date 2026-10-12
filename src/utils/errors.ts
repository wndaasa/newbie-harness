// catch로 잡은 값에서 사람이 읽을 메시지를 뽑아낸다.
//
// strict에서 catch 변수는 unknown이다. 그동안 코드 곳곳이 error.message를
// 바로 읽고 있었는데, 던져진 것이 Error가 아니면(문자열, 프로바이더가 준 객체
// 등) undefined가 그대로 화면과 세션 기록에 남는다.
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }

  return String(error);
}
