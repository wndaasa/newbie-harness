import React, { useEffect } from 'react';
import { IconAlert, IconClose } from './Icon.tsx';

/**
 * 대화와 무관한 오류 알림.
 *
 * 화면을 막지 않는다 — 시작할 때 나는 기억 정리 실패처럼 하던 일을 멈출 필요가
 * 없는 오류가 대부분이라, 확인 모달로 띄우면 매번 클릭을 강요하게 된다. 대신
 * 저절로 사라지지도 않는다(입력창 아래 notice와 다른 점). 왜 앱이 제대로 돌지
 * 않는지 알려주는 문구라 지나쳐 버리면 곤란하다.
 *
 * Esc는 캡처 단계를 쓰지 않는다. 설정창·확인창이 캡처로 Esc를 먼저 가져가므로,
 * 그것들이 열려 있을 때는 그쪽이 닫히고 아무것도 없을 때만 이 알림이 닫힌다.
 */
export function AlertPopup({ onClose, text }: { onClose: () => void; text: string }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="alert-popup" role="alert">
      {/* 색만으로 알리지 않도록 모양을 함께 둔다 */}
      <span className="alert-popup-icon">
        <IconAlert size={15} />
      </span>
      <div className="alert-popup-text">{text}</div>
      <button
        aria-label="닫기"
        className="alert-popup-close"
        onClick={onClose}
        title="닫기 (Esc)"
        type="button"
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
