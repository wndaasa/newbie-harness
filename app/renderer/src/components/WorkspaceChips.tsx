import React, { useCallback, useEffect, useState } from 'react';
import type { GitDiffSummary, WorkspaceInfo, WorktreeEntry } from '../types.ts';

// 입력창 좌측 상단의 작업 공간 칩: 폴더(클릭 → 폴더 선택), 브랜치(클릭 → 전환 메뉴),
// 우측에 main 대비 변경 통계 칩(클릭 → diff 패널)
export function WorkspaceChips({
  diffSummary,
  folderLocked,
  onOpenDiff,
  workspace,
}: {
  diffSummary: GitDiffSummary | null;
  folderLocked: boolean;
  onOpenDiff: () => void;
  workspace: WorkspaceInfo;
}) {
  return (
    // 시작된 세션만 회색 상태 바(started), 새 대화는 기존 흰 알약 칩
    <div className={folderLocked ? 'workspace-chips started' : 'workspace-chips'}>
      {folderLocked ? (
        // 대화가 시작된 세션은 폴더를 바꿀 수 없어 읽기 전용 표시로 보여줌
        <span className="workspace-chip workspace-chip-static" title={workspace.path}>
          <FolderIcon />
          <span className="workspace-chip-name">{workspace.folder}</span>
        </span>
      ) : (
        <button
          className="status-chip workspace-chip"
          onClick={() => void window.newbie.pickFolder()}
          title={`${workspace.path}\n클릭해서 작업 폴더 변경`}
          type="button"
        >
          <FolderIcon />
          {/* 긴 폴더 이름이 flex 버튼 안에서 말줄임되도록 별도 span으로 감쌈
              (텍스트 노드 그대로면 text-overflow: ellipsis가 적용되지 않음) */}
          <span className="workspace-chip-name">{workspace.folder}</span>
        </button>
      )}
      {workspace.branch && <BranchChip branch={workspace.branch} />}
      {workspace.branch && <WorktreeChip currentBranch={workspace.branch} />}
      {diffSummary && (diffSummary.insertions > 0 || diffSummary.deletions > 0) && (
        <button
          className="status-chip workspace-chip diff-stat-chip"
          onClick={onOpenDiff}
          title={`${diffSummary.base} 대비 변경 · 클릭해서 파일별 diff 보기`}
          type="button"
        >
          <span className="diff-stat add">+{diffSummary.insertions.toLocaleString()}</span>
          <span className="diff-stat del">−{diffSummary.deletions.toLocaleString()}</span>
        </button>
      )}
    </div>
  );
}

function BranchChip({ branch }: { branch: string }) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  // 메뉴를 열 때마다 목록을 새로 불러옴 (다른 곳에서 브랜치가 바뀌었을 수 있음)
  useEffect(() => {
    if (!open) return;
    setBranches(null);
    setError('');
    let stale = false;
    void window.newbie.branches().then(result => {
      if (stale) return;
      setBranches(result.branches);
      setError(result.error ?? '');
    });
    return () => {
      stale = true;
    };
  }, [open]);

  return (
    <span className="chip-anchor">
      {open && <div className="chip-menu-overlay" onClick={() => setOpen(false)} />}
      <button
        className="status-chip workspace-chip"
        onClick={() => setOpen(previous => !previous)}
        title="클릭해서 브랜치 전환"
        type="button"
      >
        <BranchIcon />
        <span className="workspace-chip-name">{branch}</span>
      </button>
      {open && (
        <div className="chip-menu left">
          <div className="chip-menu-title">브랜치</div>
          {branches === null && !error && <div className="chip-menu-note">불러오는 중...</div>}
          {error && <div className="chip-menu-note">{error}</div>}
          {branches?.map(name => (
            <button
              className="chip-menu-item"
              key={name}
              onClick={() => {
                if (name !== branch) window.newbie.checkoutBranch(name);
                setOpen(false);
              }}
              type="button"
            >
              <span className="chip-menu-ellipsis">{name}</span>
              <span className="chip-menu-key">
                {name === branch && <span className="chip-menu-check">✓</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// 워크트리 칩: 클릭하면 기존 워크트리 목록(제거 버튼)과 새 워크트리 생성 폼을 보여줌.
// LLM 도구 worktree_add와 같은 핵심 로직을 UI에서 직접 호출해 결정론적으로 만든다.
// base override 체크박스를 켜면 현재 HEAD 대신 고른 브랜치에서 새 브랜치를 출발시킨다.
function WorktreeChip({ currentBranch }: { currentBranch: string }) {
  const [open, setOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[] | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [baseOverride, setBaseOverride] = useState(false);
  const [base, setBase] = useState(currentBranch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    void window.newbie.worktrees().then(result => {
      setWorktrees(result.worktrees);
      setError(result.error ?? '');
    });
  }, []);

  // 메뉴를 열 때마다 워크트리·브랜치 목록을 새로 불러옴
  useEffect(() => {
    if (!open) return;
    setError('');
    setWorktrees(null);
    refresh();
    void window.newbie.branches().then(result => {
      setBranches(result.branches);
    });
  }, [open, refresh]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    const result = await window.newbie.worktreeAdd(trimmed, baseOverride ? base : undefined);
    setBusy(false);
    if (result.ok) {
      setName('');
      refresh();
    } else {
      setError(result.message);
    }
  }

  async function handleRemove(managedName: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    const result = await window.newbie.worktreeRemove(managedName, false);
    setBusy(false);
    if (result.ok) refresh();
    else setError(result.message);
  }

  const extras = worktrees?.filter(worktree => !worktree.isMain) ?? [];

  return (
    <span className="chip-anchor">
      {open && <div className="chip-menu-overlay" onClick={() => setOpen(false)} />}
      <button
        className="status-chip workspace-chip"
        onClick={() => setOpen(previous => !previous)}
        title="워크트리 생성·관리"
        type="button"
      >
        <WorktreeIcon />
        <span className="workspace-chip-name">워크트리</span>
      </button>
      {open && (
        <div className="chip-menu left">
          <div className="chip-menu-title">워크트리</div>
          {worktrees === null && !error && <div className="chip-menu-note">불러오는 중...</div>}
          {worktrees !== null && extras.length === 0 && (
            <div className="chip-menu-note">추가된 워크트리 없음</div>
          )}
          {extras.map(worktree => (
            <div className="worktree-row" key={worktree.path}>
              <span className="chip-menu-ellipsis" title={worktree.path}>
                {worktree.branch ?? '(detached)'}
              </span>
              {worktree.managedName && (
                <button
                  className="worktree-remove"
                  disabled={busy}
                  onClick={() => void handleRemove(worktree.managedName as string)}
                  type="button"
                >
                  제거
                </button>
              )}
            </div>
          ))}

          <div className="chip-menu-title model">새 워크트리</div>
          {baseOverride ? (
            <select
              className="worktree-base-select"
              onChange={event => setBase(event.target.value)}
              value={base}
            >
              {branches.map(branchName => (
                <option key={branchName} value={branchName}>
                  {branchName}
                </option>
              ))}
            </select>
          ) : (
            <div className="worktree-base-default">
              출발: <strong>{currentBranch}</strong>
              <span className="worktree-base-hint"> (현재 브랜치)</span>
            </div>
          )}
          <label className="worktree-base-toggle">
            <input
              checked={baseOverride}
              onChange={event => setBaseOverride(event.target.checked)}
              type="checkbox"
            />
            다른 브랜치에서 출발
          </label>
          <div className="chip-menu-input">
            <input
              onChange={event => setName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void handleCreate();
              }}
              placeholder="이름 (예: fix-login)"
              value={name}
            />
            <button
              disabled={busy || !name.trim()}
              onClick={() => void handleCreate()}
              type="button"
            >
              생성
            </button>
          </div>
          {error && <div className="chip-menu-note worktree-error">{error}</div>}
        </div>
      )}
    </span>
  );
}

function FolderIcon() {
  return (
    <svg className="workspace-chip-icon" fill="none" height="12" viewBox="0 0 16 16" width="12">
      <path
        d="M1.75 3.5c0-.7.55-1.25 1.25-1.25h3l1.5 1.75h5.5c.7 0 1.25.55 1.25 1.25v6.5c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25v-8.25z"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg className="workspace-chip-icon" fill="none" height="12" viewBox="0 0 16 16" width="12">
      <circle cx="4.5" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4.5 5.3v5.4M11.5 6.8c0 2.5-3 3.2-5.2 3.6"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function WorktreeIcon() {
  return (
    <svg className="workspace-chip-icon" fill="none" height="12" viewBox="0 0 16 16" width="12">
      <circle cx="3.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 5.1v3.4c0 1 .8 1.8 1.8 1.8h1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 8v2.3c0 1 .8 1.8 1.8 1.8h1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect height="3" rx="0.8" stroke="currentColor" strokeWidth="1.3" width="4.5" x="8.2" y="2.2" />
      <rect height="3" rx="0.8" stroke="currentColor" strokeWidth="1.3" width="4.5" x="8.2" y="10.8" />
    </svg>
  );
}
