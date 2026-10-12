// 화면 캡처 도구의 승인 판정 회귀 테스트.
//
// 이 도구는 페이지의 스크립트를 실제로 실행한다. 자기가 만든 화면을 확인하는
// 용도(루프백)까지 승인을 받게 하면 확인 루프가 성립하지 않고, 반대로 바깥
// 주소까지 조용히 열면 프롬프트 인젝션이 브라우저를 끌고 다닐 수 있다.

import { describe, expect, test } from 'bun:test';
import {
  capturePageApprovalReason,
  isLoopbackUrl,
  localPathApprovalReason,
} from '../src/tools/capture/capturePage.ts';
import { getToolApprovalReason, getToolKind } from '../src/tools/registry.ts';
import '../src/tools/capture/capturePage.ts';

describe('루프백 판정', () => {
  const loopback = [
    'http://localhost:5173',
    'http://localhost:3000/some/path',
    'http://127.0.0.1:8080',
    'http://[::1]:5173',
  ];
  for (const url of loopback) {
    test(`루프백: ${url}`, () => {
      expect(isLoopbackUrl(url)).toBe(true);
      expect(capturePageApprovalReason(url)).toBeNull();
    });
  }

  const external = [
    'https://example.com',
    'http://192.168.0.10:3000',
    // 이름이 루프백처럼 보여도 실제 호스트가 다르면 외부다
    'http://localhost.evil.com',
  ];
  for (const url of external) {
    test(`외부: ${url}`, () => {
      expect(isLoopbackUrl(url)).toBe(false);
      expect(capturePageApprovalReason(url)).not.toBeNull();
    });
  }
});

describe('스킴 제한', () => {
  test('http/https가 아니면 승인 대상', () => {
    expect(capturePageApprovalReason('file:///C:/secret.html')).not.toBeNull();
    expect(capturePageApprovalReason('data:text/html,<h1>x</h1>')).not.toBeNull();
  });

  test('빈 값이나 형식 오류는 실행 시점에 알린다', () => {
    expect(capturePageApprovalReason('')).toBeNull();
    expect(capturePageApprovalReason('그냥 문자열')).toBeNull();
  });
});

describe('로컬 파일', () => {
  // path를 못 받던 시절, 모델이 index.html을 만들어 놓고도 띄울 서버가 없어
  // 확인을 건너뛰고 "만들었습니다"로 끝냈다. 실제 앱에서 그 장면을 봤다.
  test('작업 폴더 안의 파일은 그냥 연다', () => {
    expect(localPathApprovalReason('demo/index.html')).toBeNull();
    expect(localPathApprovalReason('./index.html')).toBeNull();
  });

  test('작업 폴더 밖은 승인을 받는다', () => {
    expect(localPathApprovalReason('../다른곳/index.html')).not.toBeNull();
  });

  // 드라이브 문자 경로는 Windows의 path만 절대 경로로 본다. 다른 OS에서는 작업
  // 폴더 아래의 상대 경로로 풀려 통과하므로, 앱이 도는 Windows에서만 검사한다
  test.if(process.platform === 'win32')('드라이브 문자 절대 경로도 작업 폴더 밖이다', () => {
    expect(localPathApprovalReason('C:/Windows/System32/drivers/etc/hosts')).not.toBeNull();
  });

  test('빈 값은 실행 시점에 알린다', () => {
    expect(localPathApprovalReason('')).toBeNull();
  });
});

describe('도구 등록 상태', () => {
  test('capture_page는 read이고 게이트를 갖는다', () => {
    expect(getToolKind('capture_page')).toBe('read');
    expect(getToolApprovalReason('capture_page', { url: 'http://localhost:5173' })).toBeNull();
    expect(getToolApprovalReason('capture_page', { url: 'https://example.com' })).not.toBeNull();
  });

  test('path를 주면 파일 기준으로 판정한다', () => {
    expect(getToolApprovalReason('capture_page', { path: 'demo/index.html' })).toBeNull();
    expect(getToolApprovalReason('capture_page', { path: '../밖/index.html' })).not.toBeNull();
  });
});
