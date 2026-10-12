// 백그라운드 프로세스 회귀 테스트.
//
// run_command는 프로세스가 끝나야 결과를 돌려주고 180초에 죽인다. 그래서 개발
// 서버를 띄워둘 수 없었고, 에이전트가 만든 화면을 확인하려면 사람이 대신 서버를
// 띄워줘야 했다. 이 경로가 막히면 자기 검증 루프가 다시 끊긴다.

import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  listBackgroundProcesses,
  readBackgroundOutput,
  startBackgroundCommand,
  stopAllBackgroundCommands,
  stopBackgroundCommand,
} from '../src/tools/shell/backgroundProcesses.ts';

const isWindows = process.platform === 'win32';
const echoCommand = isWindows ? 'Write-Output 안녕' : 'echo 안녕';
const sleepCommand = isWindows ? 'Start-Sleep -Seconds 30' : 'sleep 30';

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('조건이 제한 시간 안에 만족되지 않았습니다.');
}

afterEach(() => stopAllBackgroundCommands());

describe('백그라운드 실행', () => {
  test('즉시 id를 돌려주고 출력을 모아 둔다', async () => {
    const info = startBackgroundCommand(echoCommand);
    expect(info.id).toBeTruthy();
    expect(info.running).toBe(true);

    await waitFor(() => readBackgroundOutput(info.id).output.includes('안녕'));
    await waitFor(() => !readBackgroundOutput(info.id).info.running);

    const { info: done, output } = readBackgroundOutput(info.id);
    expect(output).toContain('안녕');
    expect(done.exitCode).toBe(0);
  });

  test('끝나지 않는 명령도 붙잡히지 않는다', async () => {
    // 여기가 깨지면 개발 서버를 띄우는 순간 턴이 멈춘다
    const started = Date.now();
    const info = startBackgroundCommand(sleepCommand);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(readBackgroundOutput(info.id).info.running).toBe(true);

    stopBackgroundCommand(info.id);
    expect(readBackgroundOutput(info.id).info.running).toBe(false);
  });

  // running 표시만 보면 모른다. 예전에는 macOS와 Linux에서 셸만 죽어, "종료했습니다"라고
  // 답한 뒤에도 셸이 띄운 명령(node 서버 등)이 살아 있었다
  test.if(!isWindows)('종료하면 셸이 띄운 실제 명령까지 끝난다', async () => {
    const command = `sleep 44.${process.pid}`;
    const running = () => spawnSync('pgrep', ['-f', `^${command}$`]).status === 0;
    const info = startBackgroundCommand(command);
    await waitFor(running);

    stopBackgroundCommand(info.id);

    await waitFor(() => !running(), 5_000);
  });

  test('목록에 실행 중인 프로세스가 보인다', () => {
    const info = startBackgroundCommand(sleepCommand);
    const ids = listBackgroundProcesses().map(p => p.id);
    expect(ids).toContain(info.id);
  });

  test('빈 명령과 모르는 id는 거부한다', () => {
    expect(() => startBackgroundCommand('   ')).toThrow();
    expect(() => readBackgroundOutput('없는-id')).toThrow();
    expect(() => stopBackgroundCommand('없는-id')).toThrow();
  });

  test('동시 실행 수를 제한한다', () => {
    // 제한이 없으면 서버가 쌓여 포트와 메모리를 물고 있는다
    for (let i = 0; i < 5; i += 1) startBackgroundCommand(sleepCommand);
    expect(() => startBackgroundCommand(sleepCommand)).toThrow(/5개/);
  });

  test('전체 정리가 실행 중인 프로세스를 끝낸다', () => {
    const info = startBackgroundCommand(sleepCommand);
    stopAllBackgroundCommands();
    expect(listBackgroundProcesses()).toHaveLength(0);
    expect(() => readBackgroundOutput(info.id)).toThrow();
  });
});
