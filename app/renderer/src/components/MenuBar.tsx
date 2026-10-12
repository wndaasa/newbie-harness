import { IconChevronRight, IconMenu } from './Icon.tsx';
import React, { useEffect, useState } from 'react';

type MenuAction = {
  label: string;
  shortcut?: string;
  run: () => void;
};

type MenuSection = {
  label: string;
  items: MenuAction[];
};

// 탑바 좌측 햄버거 메뉴: 상위 항목에 마우스를 올리면 오른쪽에 서브 메뉴가 열림
export function MenuBar({ onNewSession }: { onNewSession: () => void }) {
  const [open, setOpen] = useState(false);
  // 호버 중인 상위 항목. 서브 메뉴는 호버 중에만 표시됨 (null = 숨김)
  const [activeSection, setActiveSection] = useState<number | null>(null);
  // 서브 메뉴 시작 높이 = 호버한 항목의 세로 위치
  const [submenuTop, setSubmenuTop] = useState(0);

  function activateSection(index: number, target: HTMLElement) {
    setActiveSection(index);
    setSubmenuTop(target.offsetTop);
  }

  const sections: MenuSection[] = [
    {
      label: '파일',
      items: [{ label: '새 대화', shortcut: 'Ctrl+N', run: onNewSession }],
    },
  ];

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  function runItem(item: MenuAction) {
    setOpen(false);
    item.run();
  }

  return (
    <span className="menubar-anchor">
      {open && <div className="chip-menu-overlay" onClick={() => setOpen(false)} />}
      <button
        aria-label="메뉴"
        className={open ? 'topbar-button active' : 'topbar-button'}
        onClick={() => {
          setActiveSection(null);
          setOpen(previous => !previous);
        }}
        type="button"
      >
        <IconMenu size={16} />
      </button>
      {open && (
        <div
          className="menubar-menu"
          onMouseLeave={() => setActiveSection(null)}
        >
          <div className="menubar-sections">
            {sections.map((section, index) => (
              <button
                className={
                  index === activeSection
                    ? 'chip-menu-item menubar-section active'
                    : 'chip-menu-item menubar-section'
                }
                key={section.label}
                onClick={event => activateSection(index, event.currentTarget)}
                onMouseEnter={event => activateSection(index, event.currentTarget)}
                type="button"
              >
                <span>{section.label}</span>
                <span className="chip-menu-key"><IconChevronRight size={13} /></span>
              </button>
            ))}
          </div>
          {activeSection !== null && (
            <div className="menubar-submenu" style={{ top: submenuTop }}>
              {sections[activeSection].items.map(item => (
                <button
                  className="chip-menu-item"
                  key={item.label}
                  onClick={() => runItem(item)}
                  type="button"
                >
                  <span>{item.label}</span>
                  {item.shortcut && (
                    <span className="chip-menu-key">{item.shortcut}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
