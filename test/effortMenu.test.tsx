/*
 * 노력 메뉴 설명 줄 회귀 테스트.
 *
 * 설명 줄이 고른 단계의 문구로만 고정돼 있어, 다른 단계가 무엇인지 보려면 하나씩
 * 골라 봐야 했다. 마우스나 키보드 포커스가 올라간 단계를 따라가고, 벗어나면 고른
 * 단계로 돌아오는지를 본다.
 */
import { setupDom } from './domSetup.ts';

setupDom();

const { afterEach, describe, expect, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const React = (await import('react')).default;
const { EffortChip } = await import('../app/renderer/src/components/StatusMenus.tsx');

afterEach(() => cleanup());

const efforts = [
  { value: 'low', label: '낮음', hint: '짧게 생각합니다.' },
  { value: 'high', label: '높음', hint: '철저하게 생각합니다.' },
  { value: 'max', label: '최대', hint: '가장 깊게 생각합니다.' },
];

function openMenu() {
  render(<EffortChip effort="high" efforts={efforts} onSelect={() => {}} />);
  fireEvent.click(screen.getByTitle('클릭해서 추론 노력 선택'));
}

function hintText() {
  return document.querySelector('.chip-menu-hint')?.textContent;
}

function item(label: string) {
  return screen.getByText(label, { selector: '.chip-menu-item span' }).closest('button')!;
}

describe('노력 메뉴 설명 줄', () => {
  test('처음에는 고른 단계의 설명을 보인다', () => {
    openMenu();
    expect(hintText()).toBe('철저하게 생각합니다.');
  });

  test('마우스를 올린 단계의 설명으로 바뀌고, 벗어나면 돌아온다', () => {
    openMenu();
    fireEvent.mouseEnter(item('최대'));
    expect(hintText()).toBe('가장 깊게 생각합니다.');
    fireEvent.mouseLeave(item('최대'));
    expect(hintText()).toBe('철저하게 생각합니다.');
  });

  test('키보드 포커스도 같은 방식으로 따라간다', () => {
    openMenu();
    fireEvent.focus(item('낮음'));
    expect(hintText()).toBe('짧게 생각합니다.');
    fireEvent.blur(item('낮음'));
    expect(hintText()).toBe('철저하게 생각합니다.');
  });
});
