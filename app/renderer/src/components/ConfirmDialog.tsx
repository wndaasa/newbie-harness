import React, { useEffect, useRef } from 'react';
import { useTitlebarShade } from '../titlebarShade.ts';
import { useOverlayTitlebarColors } from '../theme.ts';

// 네이티브 confirm() 대체 — 앱 스타일의 확인 모달. Enter 확인, Esc/바깥 클릭 취소
export function ConfirmDialog({
  cancelLabel = '취소',
  confirmLabel = '확인',
  message,
  onCancel,
  onConfirm,
  onEscape,
  tone = 'danger',
}: {
  cancelLabel?: string;
  confirmLabel?: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  /**
   * Esc·바깥 클릭이 취소와 달라야 할 때 쓴다.
   *
   * 취소 버튼이 "저장 안 함"처럼 값을 버리는 선택지면, Esc가 그리로 이어지면
   * 안 된다 — 두 번 누르다 실수로 버리게 된다. 기본값은 취소와 같다.
   */
  onEscape?: () => void;
  /** 확인이 파괴적이지 않을 때 'primary' — 빨강 대신 강조색을 쓴다 */
  tone?: 'danger' | 'primary';
}) {
  const dismiss = onEscape ?? onCancel;
  // styles.css의 .confirm-overlay 배경과 같은 값이어야 OS 타이틀바가 막과 이어진다
  const shade = useOverlayTitlebarColors(20, 18, 28, 0.82);
  useTitlebarShade(shade.color, shade.symbolColor);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismiss();
      } else if (event.key === 'Enter') {
        event.stopPropagation();
        onConfirm();
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dismiss, onConfirm]);

  return (
    <div className="confirm-overlay" onClick={dismiss}>
      <div
        className="confirm-dialog"
        onClick={event => event.stopPropagation()}
        role="alertdialog"
      >
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onCancel} type="button">
            {cancelLabel}
          </button>
          <button
            className={`confirm-ok${tone === 'primary' ? ' primary' : ''}`}
            onClick={onConfirm}
            ref={confirmRef}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
