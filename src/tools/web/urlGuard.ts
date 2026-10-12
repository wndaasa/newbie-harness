// web_fetch가 내부망·로컬 서비스로 향하지 않도록 검사한다.
//
// web_fetch는 kind가 read라 권한 모드상 자동 실행된다. 검사가 스킴뿐이면
// 프롬프트 인젝션으로 http://127.0.0.1:11434(로컬 LLM), 내부망 주소,
// 169.254.169.254(클라우드 메타데이터)를 찌를 수 있고, 읽은 내용은 그대로
// 모델 컨텍스트로 들어온다.
//
// 호스트 이름만 보면 이름이 사설 IP로 풀리는 경우를 놓치므로, DNS로 해석한
// 주소를 확인한다. 리다이렉트도 매 홉마다 다시 검사해야 최초 검사만 통과시키고
// 내부로 튀는 것을 막을 수 있다.
//
// DNS 리바인딩은 완전히 막지 못한다. 여기서 해석한 뒤 fetch가 연결할 때 이름을
// 다시 해석하므로, 그 사이에 응답을 바꾸는 DNS 서버(짧은 TTL)는 검사를 통과한
// 이름으로 내부 주소에 닿을 수 있다. 막으려면 검사한 주소로 직접 연결해야 하는데
// fetch는 해석 결과를 고정하는 방법을 주지 않는다.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** 사설·예약 대역이면 사유를, 공인 주소면 null을 반환 */
export function privateAddressReason(address: string): string | null {
  const version = isIP(address);
  if (version === 4) return privateIPv4Reason(address);
  if (version === 6) return privateIPv6Reason(address);
  return null;
}

function privateIPv4Reason(address: string): string | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return `해석할 수 없는 주소입니다: ${address}`;
  }
  const [a, b] = parts;

  if (a === 127) return `루프백 주소입니다: ${address}`;
  if (a === 10) return `사설망 주소입니다: ${address}`;
  if (a === 172 && b >= 16 && b <= 31) return `사설망 주소입니다: ${address}`;
  if (a === 192 && b === 168) return `사설망 주소입니다: ${address}`;
  if (a === 169 && b === 254) return `링크로컬·메타데이터 주소입니다: ${address}`;
  if (a === 100 && b >= 64 && b <= 127) return `통신사 내부(CGNAT) 주소입니다: ${address}`;
  if (a === 0) return `예약된 주소입니다: ${address}`;
  if (a >= 224) return `멀티캐스트·예약 대역 주소입니다: ${address}`;

  return null;
}

/**
 * IPv6 주소를 16비트 그룹 8개로 편다. 끝에 IPv4 표기가 붙은 형태(::ffff:1.2.3.4)도
 * 받는다. 형식이 틀리면 null.
 *
 * 문자열 모양으로 판정하면 같은 주소의 다른 표기를 놓친다. WHATWG URL은
 * [::ffff:127.0.0.1]을 [::ffff:7f00:1]로 바꿔 내보내는데, 예전 정규식은
 * 점 표기만 찾아 이 형태를 공인 주소로 통과시켰다.
 */
function expandIPv6(address: string): number[] | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, '');
  // 영역 지정자(fe80::1%eth0)는 대역 판정과 무관하다
  text = text.split('%')[0];

  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const parts = tail[1].split('.').map(Number);
    if (parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    text = `${text.slice(0, -tail[1].length)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':') : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map(group => parseInt(group, 16));
}

/** 그룹 둘(32비트)을 점 표기 IPv4로 */
function embeddedIPv4(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function privateIPv6Reason(address: string): string | null {
  const groups = expandIPv6(address);
  if (!groups) return `해석할 수 없는 주소입니다: ${address}`;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const zeroPrefix = (count: number) => groups.slice(0, count).every(group => group === 0);

  if (zeroPrefix(8)) return `예약된 주소입니다: ${address}`;
  if (zeroPrefix(7) && g7 === 1) return `루프백 주소입니다: ${address}`;

  // IPv4를 품은 형태는 안쪽 IPv4로 판정한다.
  //   ::ffff:a.b.c.d  매핑 주소        ::a.b.c.d  호환 주소(폐기됨)
  //   64:ff9b::/96    NAT64             2002::/16  6to4
  if (zeroPrefix(5) && g5 === 0xffff) return privateIPv4Reason(embeddedIPv4(g6, g7));
  if (zeroPrefix(6)) {
    return privateIPv4Reason(embeddedIPv4(g6, g7)) ?? `폐기된 IPv4 호환 주소입니다: ${address}`;
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return privateIPv4Reason(embeddedIPv4(g6, g7));
  }
  if (g0 === 0x2002) return privateIPv4Reason(embeddedIPv4(g1, g2));

  // fc00::/7 유니크 로컬, fe80::/10 링크로컬, fec0::/10 사이트 로컬(폐기됨), ff00::/8 멀티캐스트
  if ((g0 & 0xfe00) === 0xfc00) return `사설망(유니크 로컬) 주소입니다: ${address}`;
  if ((g0 & 0xffc0) === 0xfe80) return `링크로컬 주소입니다: ${address}`;
  if ((g0 & 0xffc0) === 0xfec0) return `사이트 로컬 주소입니다: ${address}`;
  if ((g0 & 0xff00) === 0xff00) return `멀티캐스트 주소입니다: ${address}`;

  return null;
}

/**
 * URL 한 홉을 검사한다. 문제가 있으면 사유를, 없으면 null을 반환한다.
 * 호스트가 이름이면 DNS로 해석해 모든 결과 주소를 확인한다.
 */
export async function checkFetchUrl(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `URL 형식이 올바르지 않습니다: ${url}`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `http:// 또는 https:// 만 사용할 수 있습니다: ${url}`;
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) {
    const reason = privateAddressReason(host);
    return reason ? `내부 주소에는 접근할 수 없습니다 — ${reason}` : null;
  }

  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    return `내부 주소에는 접근할 수 없습니다 — 로컬 호스트입니다: ${host}`;
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return `호스트 이름을 확인할 수 없습니다: ${host}`;
  }

  for (const { address } of addresses) {
    const reason = privateAddressReason(address);
    if (reason) {
      return `내부 주소에는 접근할 수 없습니다 — ${host}가 ${reason}`;
    }
  }

  return null;
}
