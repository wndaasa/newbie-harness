import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { registerTool } from '../registry.ts';
import { getWorkdir } from '../../agent/workdir.ts';
import { nonInteractiveEnv } from '../shell/nonInteractiveEnv.ts';
import { GIT_READ_ONLY_COMMANDS, validateGitArgs } from './gitReadOnlyCommands.ts';

const GIT_TIMEOUT_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_SNAPSHOT_STATUS_LINES = 20;

// 읽기 전용 서브커맨드만 허용. branch/tag/remote는 인자에 따라 저장소를 변경할 수
// 있어 제외함 — 브랜치 목록은 log --all·rev-parse·status로 대신 조회 가능.
// 저장소를 변경하는 명령(commit, push 등)은 이 도구로 실행할 수 없고 run_command를
// 거친다. run_command는 git도 같은 읽기 전용 목록으로 판정하므로(safeCommands.ts),
// 변경 명령은 승인 판정을 받는다 — 자동 모드에서는 분류기, 다른 모드에서는 사용자.
// 서브커맨드별로 허용되는 플래그는 gitReadOnlyCommands.ts가 정의한다.
const READ_SUBCOMMANDS = Object.keys(GIT_READ_ONLY_COMMANDS);

export async function runGitTool(argsText: string): Promise<string> {
  const tokens = tokenizeArgs(String(argsText ?? '').trim());
  if (tokens.length === 0) {
    throw new Error('실행할 git 인자가 비어 있습니다. 예: "log --oneline -10"');
  }

  const subcommand = tokens[0];
  if (!GIT_READ_ONLY_COMMANDS[subcommand]) {
    throw new Error(
      `run_git은 읽기 전용 명령만 실행합니다: ${READ_SUBCOMMANDS.join(', ')}. ` +
        '저장소를 변경하는 명령은 run_command로 실행하세요 (승인 판정을 거칩니다).',
    );
  }

  // 서브커맨드가 읽기 전용이어도 옵션이 외부 명령을 실행시킬 수 있으므로
  // (grep --open-files-in-pager 등) 플래그를 허용목록으로 검증한다
  const rejection = validateGitArgs(subcommand, tokens.slice(1));
  if (rejection) {
    throw new Error(rejection);
  }

  return await new Promise((resolveResult, reject) => {
    const proc = spawn('git', ['--no-pager', ...tokens], {
      cwd: getWorkdir(),
      env: nonInteractiveEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      stdout += chunk;
    });
    proc.stderr.on('data', chunk => {
      stderr += chunk;
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, GIT_TIMEOUT_MS);

    proc.on('error', err => {
      clearTimeout(killTimer);
      reject(err);
    });
    proc.on('close', exitCode => {
      clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`git 명령이 시간 초과(${GIT_TIMEOUT_MS / 1000}초)로 중단됐습니다.`));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`git 실행 실패 (종료 코드 ${exitCode}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const output = stdout.trimEnd();
      if (!output) {
        resolveResult('(출력 없음)');
        return;
      }
      resolveResult(truncate(output, MAX_OUTPUT_CHARS));
    });
  });
}

/** 현재 브랜치 이름. git 저장소가 아니거나 git이 없으면 null (홈 화면 표시용) */
export async function getCurrentGitBranch(): Promise<string | null> {
  return runGitQuiet(['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** 로컬 브랜치 목록. git 저장소가 아니면 null (브랜치 칩 메뉴용) */
export async function listGitBranches(): Promise<string[] | null> {
  const output = await runGitQuiet(['branch', '--format=%(refname:short)']);
  if (output === null) return null;
  return output.split('\n').filter(Boolean);
}

/**
 * 브랜치 전환. LLM 도구가 아니라 사용자가 UI(브랜치 칩)에서 직접 누를 때만
 * 호출됨 — run_git의 읽기 전용 원칙과 별개. 실패(충돌 등) 시 git 메시지를 던짐.
 */
export function checkoutGitBranch(name: string): void {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || trimmed.startsWith('-')) {
    throw new Error(`브랜치 이름이 올바르지 않습니다: ${name}`);
  }

  try {
    execFileSync('git', ['checkout', trimmed], {
      cwd: getWorkdir(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      windowsHide: true,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(String(stderr ?? (error as Error).message).trim());
  }
}

/**
 * 세션 시작·매 턴 시스템 프롬프트에 넣는 git 상태 스냅샷.
 *
 * git 저장소가 아니거나 git이 없어도 빈 문자열이 아니라 "아니오"를 돌려준다.
 * 예전에는 줄이 통째로 빠졌는데, 프롬프트는 "환경 정보에 git 스냅샷이 있으니
 * 그걸 보라"고 하므로 모델은 "저장소가 아님"과 "정보 누락"을 구분하지 못해
 * 매번 run_git으로 직접 확인했다. 여러 프로젝트를 담는 상위 폴더에서 새 작업을
 * 시작할 때 git 조회부터 하던 것이 이 때문이다.
 */
export async function getGitSnapshot(): Promise<string> {
  // 세 번의 git 호출을 동시에 보냄. 이전에는 execFileSync 3회가 매 턴
  // Electron 메인 스레드를 붙잡아 그동안 UI가 멈췄다
  const [branch, statusRaw, commitsRaw] = await Promise.all([
    runGitQuiet(['rev-parse', '--abbrev-ref', 'HEAD']),
    runGitQuiet(['status', '--short']),
    runGitQuiet(['log', '--oneline', '-5']),
  ]);
  if (branch === null) return 'git 저장소: 아니오';
  const statusLines = (statusRaw ?? '').split('\n').filter(Boolean);
  const status =
    statusLines.length === 0
      ? '(변경 사항 없음)'
      : statusLines
          .slice(0, MAX_SNAPSHOT_STATUS_LINES)
          .concat(
            statusLines.length > MAX_SNAPSHOT_STATUS_LINES
              ? [`...외 ${statusLines.length - MAX_SNAPSHOT_STATUS_LINES}건`]
              : [],
          )
          .join('\n    ');
  const commits = (commitsRaw ?? '').split('\n').filter(Boolean);

  return [
    `git 저장소: 예 (현재 브랜치: ${branch})`,
    `  변경 사항(git status --short):`,
    `    ${status}`,
    `  최근 커밋:`,
    ...commits.map(line => `    ${line}`),
  ].join('\n');
}

async function runGitQuiet(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: getWorkdir(),
      encoding: 'utf8',
      timeout: SNAPSHOT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

// 따옴표로 묶인 인자("커밋 메시지" 등)를 하나의 토큰으로 취급
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...(출력이 길어 ${value.length - maxLength}자 생략됨)`;
}

registerTool({
  name: 'run_git',
  kind: 'read',
  description:
    '읽기 전용 git 명령을 실행합니다 (status, log, diff, show, blame, grep, ls-files, shortlog, describe, reflog, rev-parse). ' +
    '변경 이력, 최근 수정 내용, 특정 줄의 변경 이유를 조사할 때 사용하세요. ' +
    '예: args="log --oneline -10", args="blame -L 10,20 src/config.ts". ' +
    '저장소를 변경하는 명령(commit, push 등)은 이 도구로 실행할 수 없습니다. ' +
    '옵션도 읽기 전용으로 확인된 것만 허용되므로, 거부되면 다른 옵션으로 바꾸거나 run_command로 실행하세요 (승인 판정을 거칩니다).',
  parameters: {
    type: 'object',
    properties: {
      args: {
        type: 'string',
        description: 'git 뒤에 붙는 인자 전체. 예: "log --oneline -10", "diff HEAD~1 -- src/"',
      },
    },
    required: ['args'],
  },
  execute({ args }) {
    return runGitTool(args);
  },
});
