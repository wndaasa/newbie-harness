// 끝나지 않는 명령(dev 서버 등)을 띄워 두고 출력만 따로 읽는다.
//
// run_command는 프로세스가 끝나야 결과를 돌려주고 180초에 죽인다. 그래서
// `bun run dev` 같은 건 띄울 수가 없었고, 에이전트가 만든 화면을 확인하려면
// 사람이 터미널에서 서버를 대신 띄워줘야 했다.
//
// 여기서는 프로세스를 남겨 두고 출력을 버퍼에 모아 둔다. 에이전트는 필요할 때
// 출력을 읽어 서버가 떴는지 확인하고, 끝나면 직접 종료한다.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { getWorkdir } from '../../agent/workdir.ts';
import { tieProcessToAppLifetime } from '../../utils/windowsJob.ts';
import { nonInteractiveEnv } from './nonInteractiveEnv.ts';

/** 동시에 띄울 수 있는 백그라운드 프로세스 수 */
const MAX_PROCESSES = 5;

/** 프로세스당 모아 두는 출력 길이. 넘으면 앞에서부터 버린다 */
const MAX_OUTPUT_CHARS = 100_000;

export type BackgroundProcessInfo = {
  command: string;
  exitCode: number | null;
  id: string;
  running: boolean;
  startedAt: number;
};

type BackgroundProcess = BackgroundProcessInfo & {
  output: string;
  proc: ChildProcess;
};

const processes = new Map<string, BackgroundProcess>();

/**
 * 프로세스를 자식까지 통째로 종료함.
 *
 * 여기서 띄우는 프로세스는 항상 셸(powershell/sh)이고 실제 명령은 그 자식이다.
 * proc.kill()은 셸만 죽여서, 자식(dev 서버 등)이 고아로 살아남아 포트를 문 채
 * 남는다 — 트리째 죽여야 포트가 풀린다. Windows는 taskkill /t로, macOS와 Linux는
 * 셸을 새 프로세스 그룹으로 띄워 두고(spawnOptions) 그룹째 보낸다. 예전에는
 * macOS와 Linux에서 셸만 죽여, stop_process가 "종료했습니다"라고 답한 뒤에도
 * node 프로세스가 살아 있었다 (dash는 -c로 받은 명령도 자식으로 띄운다)
 */
export function killProcessTree(proc: ChildProcess): void {
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' });
      return;
    } catch {
      // taskkill 실행 자체가 실패하면 셸이라도 죽인다
    }
  }
  if (process.platform !== 'win32' && proc.pid) {
    try {
      // 음수 pid는 그 프로세스 그룹 전체. taskkill /f처럼 강제로 끝낸다
      process.kill(-proc.pid, 'SIGKILL');
      return;
    } catch {
      // 그룹이 이미 없거나 그룹으로 띄우지 않은 프로세스면 셸이라도 죽인다
    }
  }
  proc.kill();
}

/**
 * 셸을 띄울 때 공통 옵션. macOS와 Linux에서는 새 프로세스 그룹으로 띄워
 * killProcessTree가 셸과 그 자식을 한 번에 끝낼 수 있게 한다
 */
export function processGroupOption(): { detached: boolean } {
  return { detached: process.platform !== 'win32' };
}

// OS별 셸 선택과 인코딩 보정: run_command와 같은 기준(shell/runCommand.ts의
// UTF8_PREAMBLE 주석 참고) — Windows PowerShell의 리다이렉트 출력이 콘솔 OEM
// 코드 페이지로 나와 한글이 깨지는 것을 막는다. 이 도구는 서버 콘솔 로그처럼
// 오래 쌓이는 출력을 다루므로 한글이 섞일 일이 더 많다
const UTF8_PREAMBLE =
  'chcp 65001 | Out-Null; ' +
  '[Console]::OutputEncoding = $OutputEncoding = [System.Text.Encoding]::UTF8; ';

export function shellArgs(command: string): string[] {
  if (process.platform === 'win32') {
    return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', UTF8_PREAMBLE + command];
  }
  return ['/bin/sh', '-c', command];
}

function append(entry: BackgroundProcess, chunk: string): void {
  entry.output += chunk;
  if (entry.output.length > MAX_OUTPUT_CHARS) {
    // 서버 로그는 계속 흐르므로 최근 출력을 남긴다
    entry.output = entry.output.slice(-MAX_OUTPUT_CHARS);
  }
}

export function startBackgroundCommand(command: string): BackgroundProcessInfo {
  const trimmed = command?.trim();
  if (!trimmed) throw new Error('실행할 명령이 비어 있습니다.');

  // 끝난 프로세스는 자리를 비켜 준다
  for (const [id, entry] of processes) {
    if (!entry.running) processes.delete(id);
  }
  if (processes.size >= MAX_PROCESSES) {
    throw new Error(
      `백그라운드 프로세스가 이미 ${MAX_PROCESSES}개입니다. stop_process로 정리한 뒤 다시 시도하세요.`,
    );
  }

  const [file, ...args] = shellArgs(trimmed);
  const proc = spawn(file, args, {
    cwd: getWorkdir(),
    env: nonInteractiveEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    ...processGroupOption(),
  });
  // 앱이 크래시해도 dev 서버가 고아로 남지 않게 OS 수준에서 수명을 묶는다
  tieProcessToAppLifetime(proc.pid);

  const entry: BackgroundProcess = {
    command: trimmed,
    exitCode: null,
    id: randomUUID().slice(0, 8),
    output: '',
    proc,
    running: true,
    startedAt: Date.now(),
  };

  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', chunk => append(entry, String(chunk)));
  proc.stderr?.on('data', chunk => append(entry, String(chunk)));
  proc.on('error', error => {
    append(entry, `\n[실행 실패] ${String(error)}`);
    entry.running = false;
  });
  proc.on('close', code => {
    entry.exitCode = code;
    entry.running = false;
  });

  processes.set(entry.id, entry);
  return toInfo(entry);
}

export function readBackgroundOutput(id: string): { info: BackgroundProcessInfo; output: string } {
  const entry = processes.get(String(id));
  if (!entry) throw new Error(`그런 프로세스가 없습니다: ${id}`);
  return { info: toInfo(entry), output: entry.output };
}

export function stopBackgroundCommand(id: string): BackgroundProcessInfo {
  const entry = processes.get(String(id));
  if (!entry) throw new Error(`그런 프로세스가 없습니다: ${id}`);

  if (entry.running) {
    killProcessTree(entry.proc);
    entry.running = false;
  }
  return toInfo(entry);
}

export function listBackgroundProcesses(): BackgroundProcessInfo[] {
  return [...processes.values()].map(toInfo);
}

/** 앱 종료 시 남은 프로세스 정리 (안 하면 dev 서버가 계속 떠 있는다) */
export function stopAllBackgroundCommands(): void {
  for (const id of [...processes.keys()]) {
    try {
      stopBackgroundCommand(id);
    } catch {
      // 이미 끝난 프로세스는 무시
    }
  }
  processes.clear();
}

function toInfo(entry: BackgroundProcess): BackgroundProcessInfo {
  return {
    command: entry.command,
    exitCode: entry.exitCode,
    id: entry.id,
    running: entry.running,
    startedAt: entry.startedAt,
  };
}
