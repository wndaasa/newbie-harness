import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { registerTool } from '../registry.ts';
import { getWorkdir } from '../../agent/workdir.ts';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 30_000;

// 워크트리는 프로젝트 루트의 .newbie/worktrees 폴더 아래 이름별 폴더로 생성됨 (.newbie/worktrees/<이름>).
// .newbie/는 자동으로 git 제외 처리하지 않으므로(agentWorkspace.ts) 커밋에서 빼려면
// 사용자가 .gitignore에 넣어야 한다.
const WORKTREE_ROOT_DIR = '.newbie/worktrees';

// 폴더 겸 기본 브랜치 이름 검증: 영문/숫자로 시작·끝나고 . _ - 만 허용.
// 경로 구분자(/ \), 상위 이동(..), 선행 하이픈을 차단해 지정 위치 밖으로 새지 않게 함.
const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * git을 비동기로 실행함. 워크트리 명령은 사용자가 도구로 호출하는 순간에만
 * 돌지만, execFileSync는 그동안 Electron 메인 스레드를 붙잡아 UI를 멈추므로
 * (git/git.ts의 getGitSnapshot이 동기 호출에서 겪은 문제) 비동기로 실행한다.
 */
async function runGit(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-pager', ...args], {
      cwd: getWorkdir(),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.trimEnd();
  } catch (error) {
    const err = error as { code?: string; killed?: boolean; stderr?: string; stdout?: string; message?: string };
    if (err.code === 'ENOENT') {
      throw new Error('git 실행 파일을 찾을 수 없습니다.');
    }
    if (err.killed || err.code === 'ETIMEDOUT') {
      throw new Error(`git 명령이 시간 초과(${GIT_TIMEOUT_MS / 1000}초)로 중단됐습니다.`);
    }
    const detail = String(err.stderr || err.stdout || err.message || '').trim();
    throw new Error(detail || 'git 명령 실행에 실패했습니다.');
  }
}

/** 워크트리 폴더 이름(모델이 짓는 이름) 검증. 통과하면 정리된 이름을 반환 */
export function validateWorktreeName(raw: string): string {
  const name = String(raw ?? '').trim();
  if (!name) {
    throw new Error('워크트리 이름이 비어 있습니다.');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `워크트리 이름은 영문/숫자로 시작·끝나야 하고 영문·숫자·.·_·-만 쓸 수 있습니다: "${name}"`,
    );
  }
  return name;
}

// 브랜치 이름 검증: 폴더명보다 느슨하게(슬래시 허용) 두되 명백히 위험한 형태만 거부.
// 나머지 세부 규칙은 git이 판단하도록 위임함.
export function validateBranchName(raw: string): string {
  const branch = String(raw ?? '').trim();
  if (!branch) {
    throw new Error('브랜치 이름이 비어 있습니다.');
  }
  if (branch.startsWith('-') || /\s/.test(branch) || branch.includes('..')) {
    throw new Error(`브랜치 이름이 올바르지 않습니다: "${branch}"`);
  }
  return branch;
}

async function branchExists(branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: getWorkdir(),
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 원격 추적 참조를 최신화(git fetch)함. branchOnRemote가 오래된 로컬 캐시로
 * 오판하지 않도록 제거 직전에 한 번 돌린다. best-effort — 오프라인이거나 원격이
 * 없어도 제거 흐름을 막지 않게 실패를 삼키고, 성공 여부만 반환한다.
 */
async function fetchRemoteQuietly(): Promise<boolean> {
  try {
    await execFileAsync('git', ['fetch', '--quiet'], {
      cwd: getWorkdir(),
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 브랜치가 원격에 올라가 있는지 확인함(원격 추적 참조 기준, 네트워크 접근 없음).
 * origin뿐 아니라 어떤 원격이든 refs/remotes/<remote>/<branch>가 있으면 true.
 * 원격에 있는 브랜치는 공유물이므로 워크트리 제거 시 자동 삭제하지 않고 보호한다.
 */
async function branchOnRemote(branch: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', `refs/remotes/*/${branch}`],
      { cwd: getWorkdir(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 로컬 브랜치를 안전하게 삭제함. 잃을 "고유 커밋"이 없을 때만 지운다.
 * ① 먼저 -d(현재 HEAD·업스트림 기준 안전 삭제) 시도.
 * ② -d가 거부하면(HEAD 기준 미병합), 그 커밋이 다른 브랜치나 원격 어디든 포함돼
 *    있는지 확인 — 포함돼 있으면 사라질 커밋이 없다는 뜻이라 -D로 삭제.
 * ③ 오직 이 브랜치에만 있는 커밋이면 false(보존).
 */
async function deleteLocalBranch(branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['branch', '-d', branch], {
      cwd: getWorkdir(),
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    // -d 거부: HEAD 기준으론 미병합이지만, 다른 참조가 이 커밋을 포함하면 안전
  }

  try {
    const { stdout: tipOut } = await execFileAsync('git', ['rev-parse', branch], {
      cwd: getWorkdir(),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const tip = tipOut.trim();
    const { stdout } = await execFileAsync(
      'git',
      ['branch', '-a', '--contains', tip, '--format=%(refname:short)'],
      { cwd: getWorkdir(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true },
    );
    const others = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(name => name && name !== branch);
    if (others.length > 0) {
      await execFileAsync('git', ['branch', '-D', branch], {
        cwd: getWorkdir(),
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      });
      return true;
    }
  } catch {
    // 조회·삭제 실패 시 보존 쪽으로
  }

  return false;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...(출력이 길어 ${value.length - maxLength}자 생략됨)`;
}

/** 현재 저장소의 워크트리 목록을 사람이 읽기 좋은 형태로 반환함 (읽기 전용, LLM 도구용) */
export async function listWorktrees(): Promise<string> {
  const output = await runGit(['worktree', 'list']);
  return output ? truncate(output, MAX_OUTPUT_CHARS) : '(워크트리 없음)';
}

/** UI 목록용 워크트리 한 항목 */
export type WorktreeEntry = {
  /** 절대 경로 */
  path: string;
  /** 체크아웃된 브랜치 이름. detached HEAD면 null */
  branch: string | null;
  /** 첫 항목(메인 워크트리)인지 — 제거 대상에서 제외 */
  isMain: boolean;
  /** 이 도구가 만든 .newbie/worktrees/ 아래 워크트리인지 (그럴 때만 remove 이름을 앎) */
  managedName: string | null;
};

/**
 * 워크트리를 구조화된 배열로 반환함 (UI 목록용). `git worktree list --porcelain`을
 * 파싱한다. managedName은 .newbie/worktrees/ 아래 폴더일 때만 채워져 UI 제거 버튼이
 * removeWorktree(name)에 넘길 이름이 된다.
 */
export async function getWorktrees(): Promise<WorktreeEntry[]> {
  const output = await runGit(['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  // git은 --porcelain 경로를 항상 슬래시(/)로 내보내지만 join은 OS 구분자(\)를 쓰므로,
  // Windows에서 접두사 비교가 어긋나지 않도록 양쪽 다 슬래시로 정규화한다.
  const rootPrefix = toPosix(join(getWorkdir(), WORKTREE_ROOT_DIR)) + '/';

  for (const block of output.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const pathLine = lines.find(line => line.startsWith('worktree '));
    if (!pathLine) continue;
    const path = pathLine.slice('worktree '.length).trim();
    const branchLine = lines.find(line => line.startsWith('branch '));
    const branch = branchLine
      ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '').trim()
      : null;
    const posixPath = toPosix(path);
    const managedName = posixPath.startsWith(rootPrefix)
      ? posixPath.slice(rootPrefix.length).split('/')[0]
      : null;
    entries.push({ path, branch, isMain: entries.length === 0, managedName });
  }

  return entries;
}

function toPosix(value: string): string {
  return value.replaceAll('\\', '/');
}

/**
 * .newbie/worktrees/<name>에 새 워크트리를 생성함.
 * - branch를 주면: 이미 있는 브랜치면 그 브랜치를 체크아웃, 없으면 새로 만듦
 * - branch를 생략하면: 워크트리 이름과 같은 새 브랜치를 만듦
 * - base를 주면: 새로 만드는 브랜치를 그 지점(브랜치/커밋)에서 출발시킴.
 *   생략하면 현재 HEAD에서 출발(git 기본). base는 "새 브랜치를 만들 때만" 적용되고,
 *   이미 있는 브랜치를 체크아웃하는 경우에는 무시됨(그 브랜치의 기존 위치가 유지되므로).
 */
export async function addWorktree(name: string, branch?: string, base?: string): Promise<string> {
  const worktreeName = validateWorktreeName(name);
  const relativePath = join(WORKTREE_ROOT_DIR, worktreeName);
  const absolutePath = join(getWorkdir(), relativePath);

  if (existsSync(absolutePath)) {
    throw new Error(`이미 존재하는 경로입니다: ${relativePath}. 다른 이름을 사용하세요.`);
  }

  const targetBranch = branch && branch.trim() ? validateBranchName(branch) : worktreeName;
  const startPoint = base && base.trim() ? validateBranchName(base) : undefined;

  const args = (await branchExists(targetBranch))
    ? ['worktree', 'add', relativePath, targetBranch]
    : ['worktree', 'add', '-b', targetBranch, relativePath, ...(startPoint ? [startPoint] : [])];

  await runGit(args);

  return [
    `워크트리를 생성했습니다: ${relativePath}`,
    `브랜치: ${targetBranch}${startPoint ? ` (${startPoint}에서 출발)` : ''}`,
    '이 폴더에서 독립적으로 작업할 수 있습니다.',
  ].join('\n');
}

/**
 * .newbie/worktrees/<name> 워크트리를 제거함. force=true면 커밋되지 않은 변경이 있어도 제거.
 *
 * 폴더를 지운 뒤 그 워크트리가 쓰던 브랜치도 정리한다(같은 이름으로 다시 만들 때
 * 낡은 브랜치가 딸려오는 문제 방지). 단 안전장치를 둔다:
 * - 원격에 올라간 브랜치는 공유물이라 보호(삭제 안 함)
 * - 병합되지 않은 커밋이 있는 로컬 브랜치도 보호(-d가 거부하면 남김)
 */
export async function removeWorktree(name: string, force = false): Promise<string> {
  const worktreeName = validateWorktreeName(name);
  const relativePath = join(WORKTREE_ROOT_DIR, worktreeName);
  const absolutePath = join(getWorkdir(), relativePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`해당 워크트리 경로가 없습니다: ${relativePath}`);
  }

  // 제거 후에는 브랜치를 알 수 없으므로 미리 파악해 둔다.
  const entries = await getWorktrees();
  const branch = entries.find(entry => entry.managedName === worktreeName)?.branch ?? null;

  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), relativePath];
  await runGit(args);

  const lines = [`워크트리를 제거했습니다: ${relativePath}`];

  if (branch) {
    // 원격 판정 직전에 fetch로 로컬 캐시를 최신화한다(방금 push된 브랜치를
    // "로컬 전용"으로 오판해 지우는 것을 막기 위함). 실패하면 오래된 캐시로 진행.
    const fetched = await fetchRemoteQuietly();
    if (await branchOnRemote(branch)) {
      lines.push(`브랜치 '${branch}'는 원격에 있어 보존했습니다.`);
    } else if (await deleteLocalBranch(branch)) {
      const staleWarning = fetched
        ? ''
        : ' (원격 최신화 실패 — 원격에 올라간 브랜치였다면 로컬에서만 지워졌을 수 있음)';
      lines.push(`로컬 브랜치 '${branch}'도 삭제했습니다.${staleWarning}`);
    } else {
      lines.push(
        `브랜치 '${branch}'는 병합되지 않은 커밋이 있어 보존했습니다 (수동 삭제: git branch -D ${branch}).`,
      );
    }
  }

  return lines.join('\n');
}

// 워크트리 도구 셋은 지연 도구로 둔다. 상시 노출하던 때는 "새 폴더 만들어서
// 구현해줘" 같은 요청에도 모델이 worktree_add를 후보로 보고 worktree_list부터
// 찔러봤다. 필요한 사람은 search_tools로 찾아 load_tools로 불러온다.
registerTool({
  name: 'worktree_list',
  kind: 'read',
  deferred: true,
  description:
    '현재 git 저장소의 워크트리 목록을 조회합니다 (git worktree list). ' +
    '각 워크트리의 경로, 커밋, 브랜치를 보여줍니다. 읽기 전용이라 저장소를 변경하지 않습니다.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  execute() {
    return listWorktrees();
  },
});

registerTool({
  name: 'worktree_add',
  kind: 'write',
  deferred: true,
  description:
    '프로젝트 루트의 .newbie/worktrees/<이름> 폴더에 새 git 워크트리를 만듭니다. ' +
    '워크트리는 같은 저장소를 별도 폴더로 펼쳐 다른 브랜치에서 독립적으로 병렬 작업하게 해줍니다. ' +
    'name은 작업 내용을 나타내는 짧은 이름을 직접 지어서 넘기세요(영문/숫자·.·_·-, 예: "feature-login", "fix-crash"). ' +
    'branch를 지정하면 그 브랜치가 이미 있으면 체크아웃하고 없으면 새로 만듭니다. ' +
    'branch를 생략하면 name과 같은 이름의 새 브랜치를 만듭니다. ' +
    'base를 지정하면 새로 만드는 브랜치를 그 브랜치/커밋에서 출발시킵니다(예: "main"에서 버그 수정 시작). base 생략 시 현재 HEAD에서 출발합니다.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          '워크트리 폴더 이름(모델이 작업에 맞게 직접 지음). 영문/숫자로 시작·끝나고 .·_·-만 허용. 예: "feature-login"',
      },
      branch: {
        type: 'string',
        description:
          '(선택) 체크아웃하거나 새로 만들 브랜치 이름. 생략하면 name과 같은 새 브랜치를 만듭니다.',
      },
      base: {
        type: 'string',
        description:
          '(선택) 새 브랜치의 출발 지점(브랜치/커밋). 예: "main", "dev", "origin/main". 생략하면 현재 HEAD. 이미 있는 브랜치를 체크아웃할 때는 무시됩니다.',
      },
    },
    required: ['name'],
  },
  execute({ name, branch, base }) {
    return addWorktree(name, branch, base);
  },
});

registerTool({
  name: 'worktree_remove',
  kind: 'execute',
  deferred: true,
  description:
    '.newbie/worktrees/<이름> 워크트리를 제거합니다 (git worktree remove). 되돌리기 어려운 작업이라 실행 전 사용자 승인을 받습니다. ' +
    '기본적으로 커밋되지 않은 변경이 있으면 실패하며, force="true"를 주면 강제로 제거합니다(변경 사항 유실 주의). ' +
    '폴더를 지운 뒤 그 워크트리가 쓰던 브랜치도 정리합니다. 단 원격에 올라간 브랜치나 병합되지 않은 커밋이 있는 브랜치는 보존합니다.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '제거할 워크트리 폴더 이름(.newbie/worktrees/ 아래 이름). 예: "feature-login"',
      },
      force: {
        type: 'string',
        description: '(선택) "true"면 커밋되지 않은 변경이 있어도 강제 제거. 기본은 안전하게 실패.',
      },
    },
    required: ['name'],
  },
  execute({ name, force }) {
    return removeWorktree(name, String(force).toLowerCase() === 'true');
  },
});
