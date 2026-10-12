import React, { useState } from 'react';
import { IconChevronLeft, IconChevronRight, IconClose, IconDot } from './Icon.tsx';
import { ImageLightbox } from './ImageLightbox.tsx';
import { Markdown } from './Markdown.tsx';
import { ToolItem } from './Transcript.tsx';
import type { ChildRows } from './Transcript.tsx';
import type { TranscriptRow } from '../types.ts';

/*
 * 보조 에이전트 우측 패널 — diff 패널과 같은 자리에 뜬다.
 *
 * 지시 내용·자식 도구 호출·최종 보고를 트랜스크립트에 중첩해 그리면 대화가
 * 도구 목록에 묻힌다. 트랜스크립트에는 한 줄 요약만 남기고, 클릭하면 여기서
 * 전체를 보여준다. 행 데이터는 App의 rows를 그대로 받으므로 진행 중에도
 * 자식 호출이 실시간으로 늘어난다.
 */
export function AgentPanel({
  childRows,
  onClose,
  onOpenAgent,
  row,
  siblings,
  width,
}: {
  childRows: ChildRows;
  onClose: () => void;
  /** 패널 안에 중첩된 또 다른 보조 에이전트 행을 클릭했을 때 그쪽으로 전환 */
  onOpenAgent: (id: string) => void;
  row: TranscriptRow;
  /** 같은 턴에 함께 뜬 에이전트들 (자기 자신 포함, 화면 순서) */
  siblings: TranscriptRow[];
  width: number;
}) {
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const nested = childRows.get(row.id) ?? [];
  // 형제가 하나뿐이면 순서를 보여줄 이유가 없다
  const position = siblings.findIndex(item => item.id === row.id);
  const previous = position > 0 ? siblings[position - 1] : undefined;
  const next = position >= 0 ? siblings[position + 1] : undefined;
  const running = row.toolStatus === 'running';
  const failed = row.toolStatus === 'error' || row.toolStatus === 'blocked';
  const report = row.result ?? '';
  const brief = String(row.input?.prompt ?? '').trim();

  return (
    <aside className="agent-panel" style={{ width }}>
      <div className="agent-panel-head">
        {running && <span className="tool-summary-spinner"><IconDot size={7} /></span>}
        <span className="tool-item-kind">{row.target || '탐색'}</span>
        <span className="agent-panel-title">{row.content}</span>
        {nested.length > 0 && (
          <span className="agent-panel-count">도구 {nested.length}회</span>
        )}
        {siblings.length > 1 && position !== -1 && (
          <span className="agent-panel-nav">
            <button
              aria-label="이전 보조 에이전트"
              disabled={!previous}
              onClick={() => previous && onOpenAgent(previous.id)}
              type="button"
            >
              <IconChevronLeft size={13} />
            </button>
            <span className="agent-panel-seq">
              {position + 1}/{siblings.length}
            </span>
            <button
              aria-label="다음 보조 에이전트"
              disabled={!next}
              onClick={() => next && onOpenAgent(next.id)}
              type="button"
            >
              <IconChevronRight size={13} />
            </button>
          </span>
        )}
        <button aria-label="닫기" className="agent-panel-close" onClick={onClose} type="button">
          <IconClose size={14} />
        </button>
      </div>
      <div className="agent-panel-body">
        {brief && (
          <details className="agent-brief" open>
            <summary>지시 내용</summary>
            <pre>{brief}</pre>
          </details>
        )}
        {nested.length > 0 && (
          <div className="tool-items">
            {nested.map(child => (
              <ToolItem
                activeAgentId={row.id}
                childRows={childRows}
                key={child.id}
                onOpenAgent={onOpenAgent}
                onZoomImage={setZoomImage}
                row={child}
              />
            ))}
          </div>
        )}
        {running ? (
          <div className="agent-report running">
            <span className="tool-summary-spinner"><IconDot size={7} /></span>
            보조 에이전트가 작업 중...
          </div>
        ) : failed ? (
          <pre className="term-out stderr">{report}</pre>
        ) : (
          <div className="agent-report">
            <Markdown content={report || '(보고 없음)'} />
          </div>
        )}
      </div>
      {zoomImage && <ImageLightbox onClose={() => setZoomImage(null)} src={zoomImage} />}
    </aside>
  );
}
