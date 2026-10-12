// web_fetch 주소 검사 회귀 테스트.
//
// web_fetch는 kind가 read라 자동 실행된다. 검사가 스킴뿐이던 시절에는
// 프롬프트 인젝션으로 로컬 LLM 포트나 클라우드 메타데이터 주소를 찌를 수
// 있었고, 읽은 내용이 그대로 모델 컨텍스트로 들어왔다.

import { describe, expect, test } from 'bun:test';
import { checkFetchUrl, privateAddressReason } from '../src/tools/web/urlGuard.ts';

describe('IP 대역 판정', () => {
  const blocked = [
    ['127.0.0.1', '루프백'],
    ['127.1.2.3', '루프백 대역 전체'],
    ['10.0.0.5', '사설 A'],
    ['172.16.0.1', '사설 B'],
    ['172.31.255.254', '사설 B 끝'],
    ['192.168.1.1', '사설 C'],
    ['169.254.169.254', '클라우드 메타데이터'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', '예약'],
    ['224.0.0.1', '멀티캐스트'],
    ['::1', 'IPv6 루프백'],
    ['fe80::1', 'IPv6 링크로컬'],
    ['fd00::1', 'IPv6 유니크 로컬'],
    ['::ffff:127.0.0.1', 'IPv4 매핑 루프백'],
    // WHATWG URL은 [::ffff:127.0.0.1]을 이 16진 형태로 바꿔 내보낸다
    ['::ffff:7f00:1', 'IPv4 매핑 루프백 (16진 표기)'],
    ['::ffff:a9fe:a9fe', 'IPv4 매핑 메타데이터 주소'],
    ['::ffff:c0a8:101', 'IPv4 매핑 사설 C'],
    ['0:0:0:0:0:ffff:7f00:1', '생략 없이 쓴 매핑 주소'],
    ['::127.0.0.1', 'IPv4 호환 주소'],
    ['::7f00:1', 'IPv4 호환 주소 (16진 표기)'],
    ['::', '미지정 주소'],
    ['0:0:0:0:0:0:0:1', '생략 없이 쓴 루프백'],
    ['fc00::1', 'IPv6 유니크 로컬 fc00::/8'],
    ['fec0::1', 'IPv6 사이트 로컬'],
    ['febf::1', '링크로컬 대역 끝'],
    ['ff02::1', 'IPv6 멀티캐스트'],
    ['64:ff9b::7f00:1', 'NAT64로 감싼 루프백'],
    ['2002:7f00:1::', '6to4로 감싼 루프백'],
  ];
  for (const [addr, why] of blocked) {
    test(`차단: ${addr} (${why})`, () => {
      expect(privateAddressReason(addr)).not.toBeNull();
    });
  }

  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::808:808',
    // 첫 그룹이 0fc0이라 유니크 로컬이 아니다. 문자열 접두사로 판정하던 때 오탐하던 형태
    'fc0::1',
  ];
  for (const addr of allowed) {
    test(`허용: ${addr}`, () => {
      expect(privateAddressReason(addr)).toBeNull();
    });
  }

  test('172.15와 172.32는 사설 대역이 아니다', () => {
    // 경계를 172.16~172.31로 정확히 잡았는지
    expect(privateAddressReason('172.15.0.1')).toBeNull();
    expect(privateAddressReason('172.32.0.1')).toBeNull();
  });
});

describe('URL 검사', () => {
  const blocked = [
    'http://127.0.0.1:11434/api/tags',
    'http://localhost:1234',
    'http://sub.localhost/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8080',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::127.0.0.1]/',
    'http://[::]/',
    'http://[fec0::1]/',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'not-a-url',
  ];
  for (const url of blocked) {
    test(`차단: ${url}`, async () => {
      expect(await checkFetchUrl(url)).not.toBeNull();
    });
  }

  test('해석되지 않는 호스트는 거부한다', async () => {
    // DNS로 확인할 수 없으면 사설 주소인지도 알 수 없다
    expect(await checkFetchUrl('http://이런호스트는없습니다.invalid/')).not.toBeNull();
  });
});
