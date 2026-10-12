import { IconChevronDown, IconChevronRight, IconClose } from './Icon.tsx';
import React, { useEffect, useState } from 'react';
import type { GitFileDiff } from '../types.ts';

const STATUS_LABEL: Record<GitFileDiff['status'], string> = {
  added: '추가',
  deleted: '삭제',
  modified: '수정',
  untracked: '신규',
};

// main(merge-base) 대비 파일별 diff를 보여주는 우측 패널.
// version이 바뀌면(턴 종료 등으로 통계가 갱신되면) 파일 목록을 다시 불러온다.
export function DiffPanel({
  onClose,
  version,
  width,
}: {
  onClose: () => void;
  version: string;
  width: number;
}) {
  const [files, setFiles] = useState<GitFileDiff[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let stale = false;
    void window.newbie.gitDiffFiles().then(result => {
      if (!stale) setFiles(result ?? []);
    });
    return () => {
      stale = true;
    };
  }, [version]);

  const totals = { add: 0, del: 0 };
  for (const file of files ?? []) {
    const counts = countLines(file);
    totals.add += counts.add;
    totals.del += counts.del;
  }

  function toggle(path: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <aside className="diff-panel" style={{ width }}>
      <div className="diff-panel-head">
        <span className="diff-panel-title">변경 사항</span>
        {files && (
          <span className="diff-panel-total">
            <span className="diff-stat add">+{totals.add.toLocaleString()}</span>
            <span className="diff-stat del">−{totals.del.toLocaleString()}</span>
          </span>
        )}
        <button aria-label="닫기" className="diff-panel-close" onClick={onClose} type="button">
          <IconClose size={14} />
        </button>
      </div>
      <div className="diff-panel-body">
        {files === null && <div className="diff-empty">불러오는 중...</div>}
        {files && files.length === 0 && <div className="diff-empty">변경 사항이 없습니다</div>}
        {files?.map(file => (
          <DiffFile
            collapsed={collapsed.has(file.path)}
            file={file}
            key={file.path}
            onToggle={() => toggle(file.path)}
          />
        ))}
      </div>
    </aside>
  );
}

function DiffFile({
  collapsed,
  file,
  onToggle,
}: {
  collapsed: boolean;
  file: GitFileDiff;
  onToggle: () => void;
}) {
  const { add, del } = countLines(file);
  return (
    <div className="diff-file">
      <button className="diff-file-head" onClick={onToggle} type="button">
        <span className="diff-file-chevron">{collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}</span>
        <span className={`diff-file-status s-${file.status}`}>{STATUS_LABEL[file.status]}</span>
        <span className="diff-file-path">{file.path}</span>
        <span className="diff-file-stat">
          {add > 0 && <span className="diff-stat add">+{add}</span>}
          {del > 0 && <span className="diff-stat del">−{del}</span>}
        </span>
      </button>
      {!collapsed && (
        <div className="diff-file-body">
          {file.hunks.length === 0 && (
            <div className="diff-empty small">내용을 표시할 수 없습니다 (바이너리 또는 큰 파일)</div>
          )}
          {file.hunks.map((hunk, hunkIndex) => (
            <div className="diff-hunk" key={hunkIndex}>
              <div className="diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => (
                <div className={`diff-line ${line.kind}`} key={lineIndex}>
                  <span className="diff-line-sign">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                  </span>
                  <span className="diff-line-text">{line.text || ' '}</span>
                </div>
              ))}
            </div>
          ))}
          {file.truncated && <div className="diff-empty small">…일부만 표시됨</div>}
        </div>
      )}
    </div>
  );
}

function countLines(file: GitFileDiff): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') add += 1;
      else if (line.kind === 'del') del += 1;
    }
  }
  return { add, del };
}
