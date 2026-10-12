import { spawn } from 'node:child_process';
import { approvalClassify, approvalNotice, registerTool } from '../registry.ts';
import { getWorkdir } from '../../agent/workdir.ts';
import { absoluteDeleteTargets, destructiveCommandReason } from './destructiveCommands.ts';
import { wasFileCreatedByAgent } from '../createdFiles.ts';
import { isInAgentTmp } from '../agentWorkspace.ts';
import { isAbsolute, resolve } from 'node:path';
import { unverifiedCommandReason } from './safeCommands.ts';
import {
  killProcessTree,
  processGroupOption,
  listBackgroundProcesses,
  readBackgroundOutput,
  startBackgroundCommand,
  stopBackgroundCommand,
} from './backgroundProcesses.ts';
import type { ChildProcess } from 'node:child_process';
import { tieProcessToAppLifetime } from '../../utils/windowsJob.ts';
import { nonInteractiveEnv } from './nonInteractiveEnv.ts';

// 빌드·테스트 같은 검증 명령을 감당할 수 있는 수준으로 설정
const COMMAND_TIMEOUT_MS = 180_000;
const MAX_STREAM_CHARS = 30_000;
/**
 * 셸이 끝난 뒤 파이프가 닫히길 기다리는 시간.
 *
 * 스크립트가 서버를 띄우고 끝나면 셸은 exit하지만, 서버가 물려받은 stdout 파이프를
 * 계속 쥐고 있어 close는 영영 오지 않는다. 그동안 도구는 결과를 못 돌려주고 턴이
 * 멈춰 있었다. 남은 출력을 잠깐만 받고 결과를 돌려준다
 */
const EXIT_GRACE_MS = 1_000;
/** 트리를 죽인 뒤 close를 기다리는 시간. 이미 끝난 셸에 taskkill을 걸면 아무 일도 없다 */
const KILL_GRACE_MS = 2_000;

export type CommandRunResult = {
  /** 사용자가 턴을 중단해 트리째 종료했음 */
  aborted?: boolean;
  exitCode: number;
  stderr: string;
  /** 상한을 넘어 앞에서 버린 stderr 글자 수 */
  stderrDropped?: number;
  stdout: string;
  /** 상한을 넘어 앞에서 버린 stdout 글자 수 */
  stdoutDropped?: number;
  timedOut: boolean;
};

export type CommandRunOptions = {
  /** 사용자 중단 신호. 끊기면 프로세스 트리를 죽이고 바로 돌아온다 */
  signal?: AbortSignal;
  timeoutMs?: number;
};

// 실행 중인 run_command 프로세스. 앱 종료 시 남아 있으면 트리째 정리한다 —
// 셸만 죽으면 자식(실제 명령)이 고아로 살아남아 포트를 문 채 남는다
const runningCommands = new Set<ChildProcess>();

/** 앱 종료 시 아직 실행 중인 run_command 정리 */
export function stopAllRunningCommands(): void {
  for (const proc of runningCommands) killProcessTree(proc);
  runningCommands.clear();
}

// OS별 셸 선택: Windows는 PowerShell, 그 외는 sh.
// Windows PowerShell(5.1)은 리다이렉트된 stdout/stderr를 콘솔의 OEM 코드
// 페이지(한국어 Windows는 보통 CP949)로 내보낸다. 이 프로세스는 UTF-8로만
// 읽으므로(setEncoding('utf8')), 명령이나 그 결과에 한글이나 확장 문자가
// 섞이면 두 바이트가 한 글자로 깨져 "2026년 9월 22일 →"류 안내가 물음표
// 상자로 나온다 — 모델이 이걸 읽고 "인코딩이 깨졌다"며 다른 방법을 찾느라
// 라운드를 허비하는 실제 원인이었다. 코드 페이지와 두 인코딩 변수를 UTF-8로
// 맞추고 시작한다: chcp는 외부 실행 파일(netstat 등)이 원시로 내보내는
// 바이트에, [Console]::OutputEncoding은 PowerShell 자신의 출력에,
// $OutputEncoding은 파이프라인으로 넘기는 값에 쓰인다
const UTF8_PREAMBLE =
  'chcp 65001 | Out-Null; ' +
  '[Console]::OutputEncoding = $OutputEncoding = [System.Text.Encoding]::UTF8; ';

export function shellArgs(command: string): string[] {
  if (process.platform === 'win32') {
    return (
      unwrapNestedPowerShell(command) ??
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', UTF8_PREAMBLE + command]
    );
  }
  return ['/bin/sh', '-c', command];
}

/** 따옴표 안의 공백은 가르지 않고, 토큰은 따옴표까지 원문 그대로 둔다 */
function splitRawTokens(command: string): string[] | null {
  const tokens = command.match(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g) ?? [];
  // 짝이 안 맞는 따옴표는 어느 토큰에도 들지 못하고 빠진다
  const quotes = (text: string) => text.replace(/[^"']/g, '').length;
  return quotes(tokens.join('')) === quotes(command) ? tokens : null;
}

const NESTED_POWERSHELL = /^(?:.*[\\/])?powershell(?:\.exe)?$/i;
/** 바깥 셸에 이미 있거나 결과에 영향이 없는 스위치 */
const IGNORED_SWITCHES = new Set(['-noprofile', '-noninteractive', '-nologo']);
const TRAILING_REDIRECT = /^[2*]>&1$/;
/** 벗겨 낸 인수를 -Command 안에 그대로 옮겨도 뜻이 바뀌지 않는 글자만 허용한다 */
const SAFE_ARGUMENT = /^(?:"[^"$`]*"|'[^']*'|[^\s"'$`|;&<>(){}@]+)+$/;

/**
 * `powershell -File x.ps1 2>&1`처럼 PowerShell 안에서 PowerShell을 또 띄우는 명령을
 * 한 겹 벗겨 바깥 셸이 스크립트를 직접 실행하게 한다. 해당하지 않으면 null.
 *
 * 바깥 셸은 안쪽 프로세스의 출력을 자기가 만든 파이프로 받아 EOF까지 읽는다.
 * 스크립트가 Start-Process -Redirect*로 서버를 띄우면 서버가 그 파이프를 물려받아
 * (CreateProcess 핸들 상속) 스크립트가 끝나도 EOF가 오지 않는다. 바깥 셸이 끝나지
 * 않으니 EXIT_GRACE_MS도 동작하지 않고 타임아웃까지 멈춰 있었다. 한 겹 벗기면
 * 서버는 이 프로세스와 잇는 파이프를 물려받고, 셸은 스크립트가 끝날 때 끝난다.
 *
 * 끝의 `2>&1`은 버린다. stdout과 stderr는 이쪽에서 둘 다 받는다.
 */
export function unwrapNestedPowerShell(command: string): string[] | null {
  const tokens = splitRawTokens(command.trim());
  if (!tokens || !NESTED_POWERSHELL.test(tokens[0])) return null;
  if (TRAILING_REDIRECT.test(tokens.at(-1) ?? '')) tokens.pop();

  const policy: string[] = [];
  let index = 1;
  for (; index < tokens.length; index++) {
    const token = tokens[index].toLowerCase();
    if (token === '-file') break;
    if (IGNORED_SWITCHES.has(token)) continue;
    if ((token === '-executionpolicy' || token === '-ep') && index + 1 < tokens.length) {
      policy.push('-ExecutionPolicy', tokens[++index]);
      continue;
    }
    // 모르는 스위치는 뜻을 보장할 수 없어 원래대로 실행한다
    return null;
  }

  const script = tokens[index + 1];
  const scriptArgs = tokens.slice(index + 2);
  if (!script || !/\.ps1["']?$/i.test(script)) return null;
  if (![script, ...scriptArgs].every(token => SAFE_ARGUMENT.test(token))) return null;

  // -File은 스크립트가 exit로 준 값을 종료 코드로 돌려준다. -Command에서는 그 값이
  // $LASTEXITCODE에만 남으므로 직접 넘긴다. 앞의 초기화는 이전 값이 새지 않게 한다
  const invocation = `$global:LASTEXITCODE = 0; & ${[script, ...scriptArgs].join(' ')}; exit $LASTEXITCODE`;
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    ...policy,
    '-Command',
    UTF8_PREAMBLE + invocation,
  ];
}

export async function runCommandTool(
  command: string,
  { signal, timeoutMs = COMMAND_TIMEOUT_MS }: CommandRunOptions = {},
): Promise<CommandRunResult> {
  const trimmed = command?.trim();
  if (!trimmed) {
    throw new Error('실행할 명령이 비어 있습니다.');
  }
  if (signal?.aborted) {
    return { aborted: true, exitCode: -1, stderr: '', stdout: '', timedOut: false };
  }

  const [file, ...args] = shellArgs(trimmed);
  return await new Promise((resolveResult, reject) => {
    const proc = spawn(file, args, {
      cwd: getWorkdir(),
      env: nonInteractiveEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...processGroupOption(),
    });
    runningCommands.add(proc);
    // 앱이 크래시해도 자식이 고아로 남지 않게 OS 수준에서 수명을 묶는다
    tieProcessToAppLifetime(proc.pid);

    let stdout = '';
    let stderr = '';
    let stdoutDropped = 0;
    let stderrDropped = 0;
    let timedOut = false;
    let aborted = false;
    let exitCode: number | null = null;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    // 결과는 MAX_STREAM_CHARS만큼만 모델에게 간다. 로그를 쏟는 명령이 180초 동안
    // 메모리에 수백 MB를 쌓지 않도록 받는 동안 끝부분만 남긴다 — 빌드·테스트의
    // 실패 요약은 보통 끝에 있다
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STREAM_CHARS) {
        stdoutDropped += stdout.length - MAX_STREAM_CHARS;
        stdout = stdout.slice(-MAX_STREAM_CHARS);
      }
    });
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_STREAM_CHARS) {
        stderrDropped += stderr.length - MAX_STREAM_CHARS;
        stderr = stderr.slice(-MAX_STREAM_CHARS);
      }
    });

    // close·exit 유예·타임아웃 유예·중단 중 먼저 온 쪽이 결과를 확정한다. 나머지
    // 경로는 무시하고, 파이프를 쥔 손자가 남아 있어도 스트림을 끊어 흘려보낸다
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      runningCommands.delete(proc);
      proc.stdout.destroy();
      proc.stderr.destroy();
      resolveResult({
        ...(aborted ? { aborted: true } : {}),
        exitCode: exitCode ?? -1,
        stderr,
        ...(stderrDropped ? { stderrDropped } : {}),
        stdout,
        ...(stdoutDropped ? { stdoutDropped } : {}),
        timedOut,
      });
    };
    const settleAfter = (ms: number) => {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      graceTimer = setTimeout(settle, ms);
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      // proc.kill()은 셸만 죽인다. 명령이 띄운 자식(dev 서버 등)이 고아로
      // 살아남아 포트를 문 채 남았던 실사고가 있어 트리째 종료한다
      killProcessTree(proc);
      settleAfter(KILL_GRACE_MS);
    }, timeoutMs);

    // 중지 버튼. 예전에는 이 도구가 신호를 받지 않아 서버를 띄운 스크립트 앞에서
    // 앱을 끄는 것 말고는 빠져나올 길이 없었다
    function onAbort() {
      aborted = true;
      killProcessTree(proc);
      settle();
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      runningCommands.delete(proc);
      reject(err);
    });
    proc.on('exit', code => {
      exitCode = code;
      settleAfter(EXIT_GRACE_MS);
    });
    proc.on('close', code => {
      exitCode = code ?? exitCode;
      settle();
    });
  });
}

/** 끝부분만 남긴다. 앞에서 이미 버린 분량(dropped)까지 합쳐 생략 안내를 붙인다 */
function keepTail(value: string, maxLength: number, dropped = 0): string {
  const omitted = Math.max(0, value.length - maxLength) + dropped;
  if (omitted === 0) return value;
  return `...(출력이 길어 앞부분 ${omitted}자 생략됨)\n${value.slice(-maxLength)}`;
}

/** 삭제 명령의 대상이 전부 에이전트가 만든 파일일 때 그 절대 경로들, 아니면 null */
function agentCreatedDeleteTargets(command: string): string[] | null {
  const targets = absoluteDeleteTargets(command);
  if (!targets) return null;
  const paths = targets.map(t => (isAbsolute(t) ? resolve(t) : resolve(getWorkdir(), t)));
  return paths.every(path => wasFileCreatedByAgent(path) || isInAgentTmp(path)) ? paths : null;
}

/**
 * 셸 명령 승인 판정. 세 갈래를 순서대로 본다.
 *
 *   1. 이 세션에서 직접 만든 파일만 지우는가   (agentCreatedDeleteTargets)  → notice
 *   2. 되돌릴 수 없는 형태인가                 (destructiveCommandReason)   → classify
 *   3. 자동 실행이 확인된 명령인가             (unverifiedCommandReason)    → classify
 *
 * 예전에는 2와 자격증명 접근(지금은 unverifiedCommandReason 안의
 * credentialCommandReason)이 confirm이라 권한 모드와 무관하게 사람 손을
 * 강제로 거쳤다. 그런데 이 판정은 셸 명령 문자열 전체를 정규식으로 훑는
 * 방식이라, PowerShell 스크립트가 원본 소스 코드를 문자열로 담아 올 때
 * 우연히 걸리는 단어를 위험한 명령으로 오인하는 일이 반복됐다 — "if (e.key
 * === ...)"가 개인키 파일 접근으로 잘못 걸린 사례가 그것이다. 이제는 2도
 * 3과 같은 classify로 낮춰, 자동 모드에서는 분류기가 맥락을 보고 정한다.
 * 자동 모드가 아니면 classify도 confirm과 같이 사람에게 묻는다.
 *
 * 1은 여전히 confirm보다 가벼운 notice로 정적 처리한다 — 위험을 추정하는
 * 규칙이 아니라 "대상이 이 세션에서 실제로 만든 파일인가"를 세션 기록과
 * 대조하는 사실 확인이라 오판의 여지가 없다
 */
function shellApproval(command: unknown) {
  const text = String(command ?? '');
  // 삭제 대상이 전부 이 세션에서 직접 만든 파일이나 임시 폴더 안이면 작업 폴더 밖이라도, 플래그가
  // 붙었어도 되돌릴 사용자 자료가 없다 — delete_file의 deleteApproval과 같은 기준
  // (createdFiles.ts). 분류기까지 갈 것 없이 사유만 남기고 통과시킨다
  const own = agentCreatedDeleteTargets(text);
  if (own) {
    return approvalNotice(`이 세션에서 직접 만든 파일을 삭제합니다: ${own.join(', ')}`);
  }

  const destructive = destructiveCommandReason(text);
  if (destructive) return approvalClassify(destructive);

  const unverified = unverifiedCommandReason(text);
  return unverified ? approvalClassify(unverified) : null;
}

registerTool({
  name: 'run_command',
  kind: 'execute',
  approvalGate: ({ command }) => shellApproval(command),
  description: '셸 명령을 실행합니다 (Windows는 PowerShell, macOS/Linux는 sh). 실행 전 사용자에게 승인을 요청하며 거부될 수 있습니다. 파일 도구(read_file, edit_file 등)나 run_git으로 할 수 없는 작업에만 사용하고, 명령은 한 번에 하나씩 짧게 실행하세요. 제한 시간은 180초입니다. 서버처럼 끝나지 않는 명령은 여기서 돌리지 말고 start_process로 띄운 뒤 read_process로 준비됐는지 확인하세요.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '실행할 셸 명령' },
      description: {
        type: 'string',
        description:
          '이 명령이 무엇을 하는지 한 줄 (사용자 화면에 제목으로 보임). 예: "bun·node 설치 여부 확인", "타입체크 실행"',
      },
    },
    required: ['command'],
  },
  async execute({ command }, context) {
    const result = await runCommandTool(command, { signal: context?.agent.signal });
    const lines = [
      result.aborted
        ? '사용자가 중단해 프로세스를 종료했습니다.'
        : result.timedOut
          ? `시간 초과(${COMMAND_TIMEOUT_MS / 1000}초)로 중단됨 (종료 코드: ${result.exitCode})`
          : `종료 코드: ${result.exitCode}`,
    ];
    // 출력이 하나도 없이 시간을 채웠으면 십중팔구 입력(비밀번호, y/n)을 기다린 것이다.
    // 모델이 같은 명령을 되풀이하지 않게 원인 후보를 같이 준다
    if (result.timedOut && !result.stdout.trim() && !result.stderr.trim()) {
      lines.push(
        '출력 없이 시간을 채웠습니다. 키보드 입력(비밀번호, 확인 y/n 등)을 기다렸을 가능성이 큽니다. 같은 명령을 다시 실행하지 말고, 입력을 묻지 않는 플래그(psql -w, ssh -o BatchMode=yes, -y 등)를 쓰거나 필요한 자격 증명을 환경 변수·설정 파일로 준비해 달라고 사용자에게 요청하세요.',
      );
    }
    if (result.stdout.trim()) {
      lines.push('--- stdout ---', keepTail(result.stdout.trimEnd(), MAX_STREAM_CHARS, result.stdoutDropped));
    }
    if (result.stderr.trim()) {
      lines.push('--- stderr ---', keepTail(result.stderr.trimEnd(), MAX_STREAM_CHARS, result.stderrDropped));
    }
    if (!result.stdout.trim() && !result.stderr.trim()) {
      lines.push('(출력 없음)');
    }
    return lines.join('\n');
  },
});

registerTool({
  name: 'start_process',
  kind: 'execute',
  approvalGate: ({ command }) => shellApproval(command),
  description:
    '끝나지 않는 명령을 백그라운드로 띄웁니다 (개발 서버, 파일 감시 등). 바로 프로세스 id를 돌려주며, 출력은 read_process로 확인하고 다 쓰면 stop_process로 종료하세요. 금방 끝나는 명령에는 run_command를 쓰세요.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '백그라운드로 실행할 셸 명령' },
      description: {
        type: 'string',
        description: '이 명령이 무엇을 하는지 한 줄 (사용자 화면에 제목으로 보임). 예: "개발 서버 시작"',
      },
    },
    required: ['command'],
  },
  execute({ command }) {
    const info = startBackgroundCommand(command);
    return [
      `백그라운드로 실행했습니다 (id: ${info.id})`,
      `명령: ${info.command}`,
      '출력은 read_process로 확인하세요. 서버라면 뜨기까지 잠시 걸릴 수 있습니다.',
    ].join('\n');
  },
});

registerTool({
  name: 'read_process',
  kind: 'read',
  description:
    'start_process로 띄운 프로세스의 출력과 상태를 읽습니다. id를 생략하면 실행 중인 프로세스 목록을 돌려줍니다.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '프로세스 id (생략하면 목록)' },
    },
    required: [],
  },
  execute({ id }) {
    if (!id) {
      const all = listBackgroundProcesses();
      if (all.length === 0) return '백그라운드 프로세스가 없습니다.';
      return all
        .map(p => `${p.id}  ${p.running ? '실행 중' : `종료 (코드 ${p.exitCode})`}  ${p.command}`)
        .join('\n');
    }

    const { info, output } = readBackgroundOutput(id);
    const status = info.running
      ? `실행 중 (${Math.round((Date.now() - info.startedAt) / 1000)}초 경과)`
      : `종료됨 (코드 ${info.exitCode})`;
    return [
      `${info.id} — ${status}`,
      `명령: ${info.command}`,
      '--- 출력 ---',
      // 백그라운드 버퍼는 100k자까지 쌓인다. 상태를 볼 때마다 그걸 통째로 돌려주면
      // 서버 로그를 확인하는 몇 번의 호출로 컨텍스트가 찬다. run_command와 같은 상한
      keepTail(output.trim(), MAX_STREAM_CHARS) || '(아직 출력 없음)',
    ].join('\n');
  },
});

registerTool({
  name: 'stop_process',
  kind: 'execute',
  description: 'start_process로 띄운 백그라운드 프로세스를 종료합니다.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '종료할 프로세스 id' },
    },
    required: ['id'],
  },
  execute({ id }) {
    const info = stopBackgroundCommand(id);
    return `프로세스를 종료했습니다: ${info.id} (${info.command})`;
  },
});
