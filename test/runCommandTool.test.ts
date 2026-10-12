// run_command 종료 경로 회귀 테스트.
//
// 서버를 띄우는 스크립트를 run_command로 돌리면, 셸은 끝나도 서버가 물려받은
// stdout 파이프를 쥐고 있어 close가 영영 오지 않았다. 도구는 결과를 못 돌려주고
// 타임아웃은 이미 끝난 셸에 걸려 소용없었으며, 중지 버튼도 이 도구에는 닿지 않아
// 앱을 끄는 것 말고는 빠져나올 길이 없었다.

import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { runCommandTool, unwrapNestedPowerShell } from '../src/tools/shell/runCommand.ts';

const isWindows = process.platform === 'win32';

/** 명령줄이 정확히 command인 프로세스가 사라질 때까지 기다린다 (셸 쪽 명령줄은 걸리지 않게 ^…$) */
async function waitUntilGone(command: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnSync('pgrep', ['-f', `^${command}$`]).status !== 0) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

describe('run_command 종료 경로', () => {
  // sh에서 `sleep 3 &`는 stdout을 물려받은 채 남는다 — 서버를 띄운 스크립트와 같은 모양
  test.if(!isWindows)('셸이 끝나면 파이프를 쥔 손자가 남아 있어도 결과가 돌아온다', async () => {
    const started = Date.now();
    const result = await runCommandTool('sleep 3 & echo hi');
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result.stdout.trim()).toBe('hi');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test('제한 시간을 넘기면 트리를 죽이고 시간 초과로 돌아온다', async () => {
    const started = Date.now();
    const result = await runCommandTool(isWindows ? 'Start-Sleep -Seconds 30' : 'sleep 30', {
      timeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
  });

  test('중단 신호가 끊기면 바로 돌아온다', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const result = await runCommandTool(isWindows ? 'Start-Sleep -Seconds 30' : 'sleep 30', {
      signal: controller.signal,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.aborted).toBe(true);
  });

  // 중단 버튼과 "지금 보내기"는 셸만이 아니라 셸이 띄운 명령까지 끝내야 한다. 예전에는
  // macOS와 Linux에서 셸만 죽어 실제 명령이 고아로 남았다 (dash는 -c 명령도 자식으로 띄운다)
  test.if(!isWindows)('중단하면 셸이 띄운 명령까지 끝난다', async () => {
    const command = `sleep 43.${process.pid}`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await runCommandTool(command, { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(await waitUntilGone(command)).toBe(true);
  });

  test('이미 끊긴 신호면 실행하지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCommandTool('echo never', { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.stdout).toBe('');
  });
});

// PowerShell 안에서 PowerShell을 또 띄우면 바깥 셸이 안쪽 출력 파이프를 EOF까지 읽는다.
// 스크립트가 띄운 서버가 그 파이프를 물려받으면 바깥 셸이 끝나지 않아 타임아웃까지 멈췄다
describe('중첩 PowerShell 벗기기', () => {
  const command = (args: string[] | null) => args?.at(-1)?.replace(/^.*?UTF8; /, '');

  test('-File 스크립트를 바깥 셸이 직접 실행하고 끝의 2>&1은 버린다', () => {
    const args = unwrapNestedPowerShell(
      'powershell -ExecutionPolicy Bypass -File C:\\Users\\user\\start-local.ps1 2>&1',
    );
    expect(args?.slice(0, 5)).toEqual([
      'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    ]);
    expect(command(args)).toBe(
      '$global:LASTEXITCODE = 0; & C:\\Users\\user\\start-local.ps1; exit $LASTEXITCODE',
    );
  });

  test('따옴표로 묶은 경로와 스크립트 인수는 원문 그대로 옮긴다', () => {
    const args = unwrapNestedPowerShell(
      'powershell.exe -NoProfile -File "C:\\a b\\run.ps1" -Port 8080 *>&1',
    );
    expect(command(args)).toBe(
      '$global:LASTEXITCODE = 0; & "C:\\a b\\run.ps1" -Port 8080; exit $LASTEXITCODE',
    );
    expect(args).not.toContain('-ExecutionPolicy');
  });

  test.each([
    ['중첩이 아닌 명령', 'Get-ChildItem'],
    ['-Command로 넘긴 경우', 'powershell -Command "Get-Date"'],
    ['pwsh (다른 PowerShell)', 'pwsh -File x.ps1'],
    ['모르는 스위치', 'powershell -WindowStyle Hidden -File x.ps1'],
    ['ps1이 아닌 파일', 'powershell -File x.txt'],
    ['뒤에 다른 명령이 이어짐', 'powershell -File x.ps1; Get-Date'],
    ['파이프로 넘김', 'powershell -File x.ps1 | Out-String'],
    ['변수 확장이 들어간 인수', 'powershell -File x.ps1 "$env:TEMP"'],
    ['짝이 안 맞는 따옴표', 'powershell -File "x.ps1'],
  ])('%s는 그대로 둔다', (_, input) => {
    expect(unwrapNestedPowerShell(input)).toBeNull();
  });
});
