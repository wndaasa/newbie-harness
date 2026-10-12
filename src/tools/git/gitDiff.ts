import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getWorkdir } from '../../agent/workdir.ts';

// merge-base(main, HEAD) 대비 작업트리 diff를 계산한다.
// 즉 "브랜치가 main에서 갈라진 지점" 이후의 커밋 + 아직 저장(커밋)하지 않은
// 변경까지 모두 포함한다. UI 소스 컨트롤 패널 전용 (LLM 도구 아님).
//
// git은 비동기로 부른다. 예전에는 execFileSync로 여러 번 불러 그동안 Electron
// 메인 스레드가 멈췄고, 화면이 이 계산을 부를 때마다 앱이 잠깐씩 굳었다.

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 64 * 1024 * 1024;
// 거대한 diff로 UI가 멈추는 것을 막는 상한
const MAX_FILES = 300;
const MAX_LINES_PER_FILE = 2_000;
const MAX_UNTRACKED_BYTES = 200_000;

export type GitDiffStatus = 'added' | 'deleted' | 'modified' | 'untracked';

export type GitDiffFileStat = {
  path: string;
  insertions: number;
  deletions: number;
  status: GitDiffStatus;
};

export type GitDiffSummary = {
  /** 비교 기준 브랜치 이름 (main 또는 master) */
  base: string;
  insertions: number;
  deletions: number;
  files: GitDiffFileStat[];
};

export type GitDiffLine = { kind: 'add' | 'context' | 'del'; text: string };
export type GitDiffHunk = { header: string; lines: GitDiffLine[] };
export type GitFileDiff = {
  path: string;
  status: GitDiffStatus;
  hunks: GitDiffHunk[];
  /** 상한을 넘겨 일부만 표시한 경우 true */
  truncated?: boolean;
};

async function git(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: getWorkdir(),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    return null;
  }
}

// 로컬 main/master를 우선하고, 없으면 origin의 것을 쓴다.
async function resolveMainRef(): Promise<string | null> {
  for (const ref of ['main', 'master', 'origin/main', 'origin/master']) {
    if ((await git(['rev-parse', '--verify', '--quiet', ref])) !== null) return ref;
  }
  return null;
}

// diff 기준점: merge-base(main, HEAD). merge-base를 못 구하면 main tip으로 폴백.
async function resolveBase(): Promise<{ sha: string; label: string } | null> {
  const label = await resolveMainRef();
  if (!label) return null;
  const mergeBase = await git(['merge-base', label, 'HEAD']);
  return { sha: mergeBase ? mergeBase.trim() : label, label };
}

export async function fetchGitDiffSummary(): Promise<GitDiffSummary | null> {
  const base = await resolveBase();
  if (!base) return null;

  const [numstat, nameStatus, untracked] = await Promise.all([
    git(['--no-optional-locks', 'diff', '--numstat', base.sha]),
    git(['--no-optional-locks', 'diff', '--name-status', base.sha]),
    listUntracked(),
  ]);
  if (numstat === null) return null;
  const statusByPath = parseNameStatus(nameStatus);

  const files: GitDiffFileStat[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    // numstat: "<added>\t<removed>\t<path>" (바이너리는 added/removed가 '-')
    const parts = line.split('\t');
    if (parts.length !== 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]) || 0;
    const removed = parts[1] === '-' ? 0 : Number(parts[1]) || 0;
    const path = parts[2];
    insertions += added;
    deletions += removed;
    if (files.length < MAX_FILES) {
      files.push({ path, insertions: added, deletions: removed, status: statusByPath.get(path) ?? 'modified' });
    }
  }

  // untracked(새 파일)는 git diff에 안 잡히므로 추가분으로 따로 집계
  for (const path of untracked) {
    const added = countUntrackedLines(path);
    insertions += added;
    if (files.length < MAX_FILES) {
      files.push({ path, insertions: added, deletions: 0, status: 'untracked' });
    }
  }

  return { base: base.label, insertions, deletions, files };
}

export async function fetchGitFileDiffs(): Promise<GitFileDiff[] | null> {
  const base = await resolveBase();
  if (!base) return null;

  const [out, untracked] = await Promise.all([
    git(['--no-optional-locks', 'diff', base.sha]),
    listUntracked(),
  ]);
  if (out === null) return null;
  const files = parseUnifiedDiff(out);

  for (const path of untracked) {
    if (files.length >= MAX_FILES) break;
    const diff = untrackedFileDiff(path);
    if (diff) files.push(diff);
  }
  return files;
}

async function listUntracked(): Promise<string[]> {
  const out = await git(['ls-files', '--others', '--exclude-standard']);
  if (out === null) return [];
  return out.split('\n').map(line => line.trim()).filter(Boolean);
}

function parseNameStatus(out: string | null): Map<string, GitDiffStatus> {
  const map = new Map<string, GitDiffStatus>();
  if (!out) return map;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]?.[0];
    // 이름 변경(R)·복사(C)는 마지막 경로가 대상
    const path = parts[parts.length - 1];
    if (!path) continue;
    map.set(path, code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified');
  }
  return map;
}

// unified diff 출력을 파일별 hunk로 나눔. "diff --git" 단위로 분리.
function parseUnifiedDiff(out: string): GitFileDiff[] {
  const files: GitFileDiff[] = [];
  for (const chunk of out.split(/^diff --git /m)) {
    if (!chunk.trim()) continue;
    if (files.length >= MAX_FILES) break;

    const lines = chunk.split('\n');
    const path = parseDiffPath(lines[0] ?? '');
    let status: GitDiffStatus = 'modified';
    const hunks: GitDiffHunk[] = [];
    let current: GitDiffHunk | null = null;
    let lineCount = 0;
    let truncated = false;

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith('new file')) status = 'added';
      else if (line.startsWith('deleted file')) status = 'deleted';

      if (line.startsWith('@@')) {
        current = { header: line, lines: [] };
        hunks.push(current);
        continue;
      }
      if (!current) continue; // index/---/+++ 등 파일 헤더 메타는 건너뜀
      if (lineCount >= MAX_LINES_PER_FILE) {
        truncated = true;
        break;
      }
      if (line.startsWith('+')) current.lines.push({ kind: 'add', text: line.slice(1) });
      else if (line.startsWith('-')) current.lines.push({ kind: 'del', text: line.slice(1) });
      else if (line.startsWith(' ')) current.lines.push({ kind: 'context', text: line.slice(1) });
      else continue; // "\ No newline at end of file" 등
      lineCount += 1;
    }

    files.push({ path, status, hunks, ...(truncated ? { truncated: true } : {}) });
  }
  return files;
}

// "a/src/foo.ts b/src/foo.ts" → "src/foo.ts"
function parseDiffPath(header: string): string {
  const match = header.match(/ b\/(.+)$/);
  const path = match ? match[1] : header.trim();
  return path.replace(/^"|"$/g, '');
}

function countUntrackedLines(path: string): number {
  const text = readUntracked(path);
  if (text === null) return 0;
  return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
}

function untrackedFileDiff(path: string): GitFileDiff | null {
  const text = readUntracked(path);
  if (text === null) return { path, status: 'untracked', hunks: [] };

  const rows = text.split('\n');
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();

  const lines: GitDiffLine[] = [];
  let truncated = false;
  for (const row of rows) {
    if (lines.length >= MAX_LINES_PER_FILE) {
      truncated = true;
      break;
    }
    lines.push({ kind: 'add', text: row });
  }

  return {
    path,
    status: 'untracked',
    hunks: lines.length ? [{ header: `@@ -0,0 +1,${lines.length} @@`, lines }] : [],
    ...(truncated ? { truncated: true } : {}),
  };
}

// 텍스트면 내용을, 바이너리·과대 파일이면 null을 반환
function readUntracked(path: string): string | null {
  try {
    const abs = join(getWorkdir(), path);
    // 크기부터 본다. 예전에는 다 읽은 뒤에 상한을 검사해, 수십 MB짜리 데이터
    // 파일도 목록을 갱신할 때마다 통째로 읽었다
    if (statSync(abs).size > MAX_UNTRACKED_BYTES) return null;
    const buf = readFileSync(abs);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}
