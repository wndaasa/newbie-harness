/*
 * 렌더러 컴포넌트 회귀 테스트.
 *
 * main 프로세스와 순수 로직은 테스트가 있었지만 화면은 비어 있었고, 그 사이로
 * 실제 버그가 빠져나갔다 — 컨텍스트 측정이 응답을 받고도 버려서 "구성별 측정 중"에
 * 갇힌 적이 있다. IPC를 직접 부르는 검증으로는 잡히지 않고 컴포넌트를 그려봐야 한다.
 *
 * DOM은 이 파일 안에서만 등록한다. 전역 preload로 두면 happy-dom이 fetch를
 * 갈아끼워 HTTP를 모킹하는 다른 테스트가 깨진다.
 */
import { setupDom } from './domSetup.ts';

setupDom();

const { afterEach, describe, expect, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen, waitFor } = await import(
  '@testing-library/react',
);
const React = (await import('react')).default;
const { ContextRing } = await import('../app/renderer/src/components/StatusMenus.tsx');

const TOKENS = { cached: 0, input: 20_000, used: 20_500, window: 200_000 };

function stubBridge(breakdown: unknown) {
  (globalThis as any).window.newbie = {
    contextBreakdown: () => Promise.resolve(breakdown),
  };
}

afterEach(() => cleanup());

describe('컨텍스트 링', () => {
  test('펼치면 측정 결과가 화면에 반영된다', async () => {
    stubBridge({
      parts: { mcpTools: 300, system: 5_000, tools: 9_000 },
      supported: true,
    });
    render(<ContextRing tokens={TOKENS} />);

    fireEvent.click(screen.getByLabelText('컨텍스트 윈도우'));
    fireEvent.click(screen.getByText('컨텍스트 윈도우'));

    // 응답이 왔는데도 "측정 중"에 머무르면 안 된다 (effect 정리가 결과를 버리던 버그)
    await waitFor(() => expect(screen.getByText('도구 정의')).toBeTruthy());
    expect(screen.getByText('시스템 프롬프트')).toBeTruthy();
    expect(screen.getByText('MCP 도구')).toBeTruthy();
    expect(screen.queryByText('구성별 측정 중…')).toBeNull();
  });

  test('MCP 도구가 0이면 그 줄은 숨긴다', async () => {
    stubBridge({ parts: { mcpTools: 0, system: 5_000, tools: 9_000 }, supported: true });
    render(<ContextRing tokens={TOKENS} />);
    fireEvent.click(screen.getByLabelText('컨텍스트 윈도우'));
    fireEvent.click(screen.getByText('컨텍스트 윈도우'));

    await waitFor(() => expect(screen.getByText('도구 정의')).toBeTruthy());
    expect(screen.queryByText('MCP 도구')).toBeNull();
  });

  test('지원하지 않는 제공자와 측정 실패는 다른 문구를 낸다', async () => {
    stubBridge({ provider: 'openai', reason: 'unsupported', supported: false });
    render(<ContextRing tokens={TOKENS} />);
    fireEvent.click(screen.getByLabelText('컨텍스트 윈도우'));
    fireEvent.click(screen.getByText('컨텍스트 윈도우'));

    await waitFor(() =>
      expect(screen.getByText('이 제공자는 구성별 측정을 지원하지 않습니다')).toBeTruthy(),
    );
    // 총합은 제공자 실측이라 분해가 없어도 그대로 보여야 한다
    expect(screen.getByText('메시지')).toBeTruthy();
  });

  test('IPC가 거부해도 로딩에 갇히지 않는다', async () => {
    (globalThis as any).window.newbie = {
      contextBreakdown: () => Promise.reject(new Error('통신 실패')),
    };
    render(<ContextRing tokens={TOKENS} />);
    fireEvent.click(screen.getByLabelText('컨텍스트 윈도우'));
    fireEvent.click(screen.getByText('컨텍스트 윈도우'));

    await waitFor(() => expect(screen.getByText(/구성별 측정에 실패했습니다/)).toBeTruthy());
  });
});
