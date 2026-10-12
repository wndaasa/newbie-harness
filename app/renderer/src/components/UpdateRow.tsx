import React from 'react';
import type { UpdateState } from '../types.ts';

/*
 * 사이드바 하단의 업데이트 줄.
 *
 * 새 버전은 이 줄로만 알린다. 받기와 설치는 사용자가 눌러야 진행되므로, 누를 수
 * 있는 상태(받을 수 있음·받음·실패)는 버튼으로, 받는 중은 진행률만 보여주는
 * 정적인 줄로 그린다.
 */

export type UpdateRowView = {
  label: string;
  /** 두 번째 줄. 없으면 안 그린다 */
  detail?: string;
  /** 0~100. 받는 중일 때만 */
  percent?: number;
  clickable: boolean;
};

const MB = 1024 * 1024;

function megabytes(bytes: number): string {
  return `${(bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1)}MB`;
}

/** 상태를 줄에 보일 글자로 바꾼다. idle이면 null — 줄 자체를 안 그린다 */
export function describeUpdate(state: UpdateState): UpdateRowView | null {
  switch (state.phase) {
    case 'idle':
      return null;
    case 'available':
      return { clickable: true, label: `Newbie ${state.version} 업데이트 가능` };
    case 'downloading': {
      const percent = Math.max(0, Math.min(100, Math.floor(state.percent)));
      return {
        clickable: false,
        detail: state.total > 0 ? `${megabytes(state.transferred)} / ${megabytes(state.total)}` : undefined,
        label: `업데이트 받는 중 ${percent}%`,
        percent,
      };
    }
    case 'downloaded':
      return { clickable: true, label: `Newbie ${state.version} 설치하고 다시 시작` };
    case 'error':
      return { clickable: true, detail: state.message, label: '업데이트를 받지 못했어요. 다시 시도' };
  }
}

export function UpdateRow({ onClick, state }: { onClick: () => void; state: UpdateState }) {
  const view = describeUpdate(state);
  if (!view) return null;

  const body = (
    <>
      <span className="update-row-label">{view.label}</span>
      {view.detail && <span className="update-row-detail">{view.detail}</span>}
      {view.percent !== undefined && (
        <span
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={view.percent}
          className="update-row-progress"
          role="progressbar"
        >
          <span className="update-row-progress-fill" style={{ width: `${view.percent}%` }} />
        </span>
      )}
    </>
  );

  if (!view.clickable) {
    return <div className="update-row">{body}</div>;
  }
  return (
    <button className="update-row clickable" onClick={onClick} type="button">
      {body}
    </button>
  );
}
