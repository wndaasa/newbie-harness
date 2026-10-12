/**
 * 개발 서버 주소의 localhost를 127.0.0.1로 바꾼다.
 *
 * Windows에서 localhost는 ::1(IPv6)로 먼저 풀린다. vite는 127.0.0.1에 붙는데
 * ::1 쪽에 죽은 소켓이 남아 있으면 요청이 응답 없이 매달리고, 창은 ready-to-show를
 * 기다리다 영영 안 뜬다. 실제로 그 상태를 겪었고 원인을 찾는 데 한참 걸렸다.
 * 어차피 같은 기계의 개발 서버라 IPv4로 고정하는 편이 안전하다.
 *
 * 본앱 창과 펫 창이 같이 쓴다.
 */
export function rendererUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
    return parsed.toString();
  } catch {
    return url;
  }
}
