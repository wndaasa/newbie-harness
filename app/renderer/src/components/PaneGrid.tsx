import React from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { DRAG_MIME } from './Pane.tsx';

/**
 * 화면 분할 격자. react-resizable-panels로 칸 사이 경계를 드래그해 크기를 조절한다.
 * 세션을 끄는 중이면(dragging) 다음 칸이 들어갈 "고스트 슬롯"을 미리 보여준다 —
 * 기존 칸들이 줄며 결과 배치가 미리 나타나고(VS Code식). 자리가 남아있는 동안은
 * 고스트든 기존 칸이든 어디에 놓아도 새 칸이 추가된다 — 놓은 자리에 새 세션이
 * 들어가고, 원래 그 자리에 있던 세션은 새로 생기는 자리로 밀려난다(내용 손실
 * 없음). 4칸이 꽉 차서 더 이상 늘릴 자리가 없을 때만, 놓은 칸의 세션이 교체된다.
 *
 * 각 칸에 data-pane-index를 달아둔다 — 칸 헤더를 끌어 자리를 바꾸는 동작은
 * App의 startPaneReorder가 마우스 이벤트를 직접 추적하며 document.elementFromPoint로
 * 이 속성을 읽어 처리한다(여기서는 관여하지 않는다).
 *
 * 레이아웃(1~4칸): 1=전체 / 2=좌우 / 3=한쪽 통짜 + 한쪽 상하 / 4=2×2
 */
export function PaneGrid({
  count,
  dragKind,
  dragging,
  focusedIndex,
  maxPanes,
  reorderOverIndex,
  renderPane,
  onFocusSlot,
  onReplace,
  onAdd,
}: {
  count: number;
  /** 지금 끄는 게 사이드바 세션인지 칸 헤더(자리 바꾸기)인지 — 드롭존 문구에 쓴다 */
  dragKind: 'session' | 'pane' | null;
  dragging: boolean;
  focusedIndex: number;
  maxPanes: number;
  /** 칸 자리 바꾸기(마우스 추적) 중 지금 커서가 올라가 있는 칸 — 세션 드롭의
      dragenter/dragleave와 별개 경로라 App이 직접 계산해 넘겨준다 */
  reorderOverIndex: number | null;
  renderPane: (index: number) => React.ReactNode;
  onFocusSlot: (index: number) => void;
  onReplace: (index: number, sessionId: string) => void;
  onAdd: (index: number, sessionId: string) => void;
}) {
  const [over, setOver] = React.useState<number | 'ghost' | null>(null);
  React.useEffect(() => {
    if (!dragging) setOver(null);
  }, [dragging]);

  // 드래그 중이고 아직 여유가 있으면 고스트 슬롯 한 칸을 덧붙여 결과 배치를 미리 본다
  const showGhost = dragging && count < maxPanes;
  const slotCount = count + (showGhost ? 1 : 0);
  const ghostIndex = showGhost ? count : -1;

  function readDragged(event: React.DragEvent): string | null {
    return event.dataTransfer.getData(DRAG_MIME) || null;
  }

  // 슬롯 하나를 실제 칸 또는 고스트로 그린다
  function cell(index: number): React.ReactNode {
    if (index === ghostIndex) {
      const ghostOver = over === 'ghost' || reorderOverIndex === index;
      return (
        <div
          className={`pane-cell ghost${ghostOver ? ' over' : ''}`}
          data-pane-index={index}
          key="ghost"
          onDragEnter={() => setOver('ghost')}
          onDragLeave={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(null);
          }}
          onDragOver={event => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
          onDrop={event => {
            event.preventDefault();
            setOver(null);
            const id = readDragged(event);
            if (id) onAdd(ghostIndex, id);
          }}
        >
          <span className="pane-ghost-label">
            <svg fill="none" height="18" viewBox="0 0 18 18" width="18">
              <path d="M9 3.5v11M3.5 9h11" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
            </svg>
            {dragKind === 'pane' ? '여기로 이동' : '여기에 새 칸'}
          </span>
        </div>
      );
    }
    const isFocused = index === focusedIndex;
    const cellOver = over === index || reorderOverIndex === index;
    return (
      <div
        className={`pane-cell${isFocused && count > 1 ? ' focused' : ''}`}
        data-pane-index={index}
        key={index}
        onFocusCapture={() => onFocusSlot(index)}
        onMouseDownCapture={() => onFocusSlot(index)}
      >
        {renderPane(index)}
        {dragging && (
          <div
            className={`pane-drop${cellOver ? ' over' : ''}`}
            onDragEnter={() => setOver(index)}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(null);
            }}
            onDragOver={event => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={event => {
              event.preventDefault();
              setOver(null);
              const id = readDragged(event);
              if (!id) return;
              // 자리가 남아있는 동안은 어디에 놓든 새 칸을 만든다 — 특정 칸(고스트)에만
              // 놓아야 하는 건 사용자 입장에서 까다롭다는 피드백. 자리가 없을 때만(4칸
              // 꽉 참) 놓은 칸의 세션을 교체한다
              if (showGhost) onAdd(index, id);
              else onReplace(index, id);
            }}
          >
            <span className="pane-drop-label">
              {dragKind === 'pane'
                ? '여기로 자리 바꾸기'
                : showGhost
                  ? '새 칸으로 열기'
                  : '이 칸에 열기'}
            </span>
          </div>
        )}
      </div>
    );
  }

  return <div className="pane-grid">{buildLayout(slotCount, cell)}</div>;
}

const MIN = '18%';
// react-resizable-panels는 게터 주변 기본 10~20px을 "리사이즈 시도"로 잡아
// 포인터다운을 가로챈다(resizeTargetMinimumSize 기본값). 칸 헤더·닫기 버튼이
// 게터 바로 옆에 있어서 그 범위에 걸려 클릭·드래그가 먹혔다 — 좁혀서 우리 쪽
// 게터 히트 영역(.pane-gutter::after, ±3px)과 비슷한 수준으로 맞춘다
const RESIZE_TARGET = { coarse: 6, fine: 4 };

// 슬롯 수에 맞는 리사이즈 격자를 만든다. panelId는 슬롯 위치 기준이라, 칸 수가
// 바뀌면 레이아웃이 새로 잡힌다 (같은 수 안에서 드래그한 크기는 유지)
function buildLayout(k: number, cell: (index: number) => React.ReactNode): React.ReactNode {
  if (k <= 1) return <div className="pane-solo">{cell(0)}</div>;

  if (k === 2) {
    return (
      <Group
        className="pane-group"
        orientation="horizontal"
        resizeTargetMinimumSize={RESIZE_TARGET}
      >
        <Panel className="pane-panel" id="s0" minSize={MIN}>
          {cell(0)}
        </Panel>
        <Separator className="pane-gutter" />
        <Panel className="pane-panel" id="s1" minSize={MIN}>
          {cell(1)}
        </Panel>
      </Group>
    );
  }

  if (k === 3) {
    return (
      <Group
        className="pane-group"
        orientation="horizontal"
        resizeTargetMinimumSize={RESIZE_TARGET}
      >
        <Panel className="pane-panel" id="s0" minSize={MIN}>
          {cell(0)}
        </Panel>
        <Separator className="pane-gutter" />
        <Panel className="pane-panel" id="sR" minSize={MIN}>
          <Group
            className="pane-group"
            orientation="vertical"
            resizeTargetMinimumSize={RESIZE_TARGET}
          >
            <Panel className="pane-panel" id="s1" minSize={MIN}>
              {cell(1)}
            </Panel>
            <Separator className="pane-gutter" />
            <Panel className="pane-panel" id="s2" minSize={MIN}>
              {cell(2)}
            </Panel>
          </Group>
        </Panel>
      </Group>
    );
  }

  // k === 4 → 2×2 (위: 0,1 / 아래: 2,3)
  return (
    <Group
      className="pane-group"
      orientation="horizontal"
      resizeTargetMinimumSize={RESIZE_TARGET}
    >
      <Panel className="pane-panel" id="sL" minSize={MIN}>
        <Group
          className="pane-group"
          orientation="vertical"
          resizeTargetMinimumSize={RESIZE_TARGET}
        >
          <Panel className="pane-panel" id="s0" minSize={MIN}>
            {cell(0)}
          </Panel>
          <Separator className="pane-gutter" />
          <Panel className="pane-panel" id="s2" minSize={MIN}>
            {cell(2)}
          </Panel>
        </Group>
      </Panel>
      <Separator className="pane-gutter" />
      <Panel className="pane-panel" id="sR" minSize={MIN}>
        <Group
          className="pane-group"
          orientation="vertical"
          resizeTargetMinimumSize={RESIZE_TARGET}
        >
          <Panel className="pane-panel" id="s1" minSize={MIN}>
            {cell(1)}
          </Panel>
          <Separator className="pane-gutter" />
          <Panel className="pane-panel" id="s3" minSize={MIN}>
            {cell(3)}
          </Panel>
        </Group>
      </Panel>
    </Group>
  );
}
