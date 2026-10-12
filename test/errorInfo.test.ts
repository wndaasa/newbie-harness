import { describe, expect, test } from 'bun:test';
import { classifyProviderError } from '../src/providers/errorInfo.ts';
import { ProviderRequestError } from '../src/providers/fetchWithRetry.ts';

function providerError(status: number, body: string) {
  return new ProviderRequestError({
    body,
    message: `Anthropic 요청 실패 (${status}): ${body}`,
    provider: 'Anthropic',
    status,
  });
}

describe('classifyProviderError', () => {
  test('404는 모델 없음으로 보고 제공자 문장만 남긴다', () => {
    const info = classifyProviderError(
      providerError(
        404,
        '{"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-20250514"},"request_id":"req_011"}',
      ),
    );
    expect(info.kind).toBe('model-not-found');
    expect(info.detail).toBe('model: claude-sonnet-4-20250514');
    // 원문 JSON이 제목으로 새지 않아야 한다
    expect(info.title).not.toContain('{');
  });

  test('401은 인증, 403은 권한으로 나눈다', () => {
    expect(classifyProviderError(providerError(401, '{"error":{"message":"bad key"}}')).kind).toBe(
      'auth',
    );
    // 403을 인증으로 뭉뚱그리면 멀쩡한 키를 다시 발급받게 만든다
    expect(classifyProviderError(providerError(403, '{"error":{"message":"forbidden"}}')).kind).toBe(
      'permission',
    );
  });

  test('429는 본문에 크레딧 얘기가 있으면 할당량으로 본다', () => {
    expect(classifyProviderError(providerError(429, 'rate limit exceeded')).kind).toBe('rate-limit');
    expect(
      classifyProviderError(providerError(429, '{"error":{"message":"insufficient credit"}}')).kind,
    ).toBe('quota');
  });

  test('400은 상태만으로 정하지 않고 본문을 본다', () => {
    const info = classifyProviderError(
      providerError(400, '{"error":{"message":"prompt is too long: 250000 tokens"}}'),
    );
    expect(info.kind).toBe('context-length');
  });

  test('게이트웨이 HTML은 상세로 흘리지 않고 따로 알린다', () => {
    const info = classifyProviderError(
      providerError(403, '<!doctype html><html><body>403 Forbidden</body></html>'),
    );
    expect(info.detail).toBe('');
    expect(info.title).toContain('웹 페이지');
  });

  test('제공자 오류가 아니면 메시지로 분류한다', () => {
    expect(classifyProviderError(new Error('fetch failed')).kind).toBe('network');
    expect(classifyProviderError(new Error('무언가 잘못됨')).kind).toBe('unknown');
  });

  test('상세는 잘려도 제목은 항상 있다', () => {
    const info = classifyProviderError(providerError(500, 'x'.repeat(5000)));
    expect(info.title).toBeTruthy();
    expect(info.detail.length).toBeLessThanOrEqual(2001);
  });
});
