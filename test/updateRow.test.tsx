/*
 * 사이드바 업데이트 줄 회귀 테스트.
 *
 * 예전에는 새 버전을 조용히 내려받아 종료할 때 설치했다. 사용자가 모르는 사이
 * 앱이 바뀌는 것이 불안하다는 피드백으로, 알리기만 하고 받기·설치는 눌러야
 * 진행되게 바꿨다. 상태마다 누를 수 있는지와 진행률이 맞게 그려지는지를 본다.
 */
import { setupDom } from './domSetup.ts';

setupDom();

const { afterEach, describe, expect, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const React = (await import('react')).default;
const { UpdateRow, describeUpdate } = await import('../app/renderer/src/components/UpdateRow.tsx');

afterEach(() => cleanup());

describe('업데이트 줄', () => {
  test('확인 전에는 아무것도 그리지 않는다', () => {
    const { container } = render(<UpdateRow onClick={() => {}} state={{ phase: 'idle' }} />);
    expect(container.innerHTML).toBe('');
  });

  test('받을 수 있으면 버전을 보여주고 누를 수 있다', () => {
    let clicks = 0;
    render(
      <UpdateRow onClick={() => (clicks += 1)} state={{ phase: 'available', version: '0.4.7' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /0\.4\.7 업데이트 가능/ }));
    expect(clicks).toBe(1);
  });

  test('받는 중에는 진행률만 보여주고 누를 수 없다', () => {
    render(
      <UpdateRow
        onClick={() => {}}
        state={{
          phase: 'downloading',
          version: '0.4.7',
          percent: 42.7,
          transferred: 90 * 1024 * 1024,
          total: 215 * 1024 * 1024,
        }}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('업데이트 받는 중 42%')).toBeTruthy();
    expect(screen.getByText('90.0MB / 215MB')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
  });

  test('받았으면 다시 시작을 권하고, 실패하면 다시 시도할 수 있다', () => {
    expect(describeUpdate({ phase: 'downloaded', version: '0.4.7' })).toEqual({
      clickable: true,
      label: 'Newbie 0.4.7 설치하고 다시 시작',
    });
    expect(describeUpdate({ phase: 'error', version: '0.4.7', message: 'net::ERR' })).toEqual({
      clickable: true,
      detail: 'net::ERR',
      label: '업데이트를 받지 못했어요. 다시 시도',
    });
  });
});
