import React, { useEffect } from 'react';
import { useTitlebarShade } from '../titlebarShade.ts';
import { useOverlayTitlebarColors } from '../theme.ts';

// 첨부 이미지 확대 보기 — 클릭 또는 Esc로 닫힘
export function ImageLightbox({ onClose, src }: { onClose: () => void; src: string }) {
  // rgba(20,18,28,.72) 오버레이 × 현재 테마 앱 배경 합성색
  const shade = useOverlayTitlebarColors(20, 18, 28, 0.72);
  useTitlebarShade(shade.color, shade.symbolColor);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <img alt="확대 이미지" src={src} />
    </div>
  );
}
