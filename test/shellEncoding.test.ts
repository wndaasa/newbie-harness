// Windows에서 run_command·start_process가 UTF-8 출력을 강제하는지 고정한다.
//
// Windows PowerShell(5.1)은 리다이렉트된 stdout/stderr를 콘솔 OEM 코드
// 페이지(한국어 Windows는 CP949)로 내보낸다. 이 도구들은 UTF-8로만 디코드하므로
// (setEncoding('utf8')), 보정 없이는 한글·확장 문자가 섞인 출력이 깨져
// "2026년 9월 22일 →" 같은 안내가 물음표 상자로 나온다.

import { afterEach, describe, expect, test } from 'bun:test';

const originalPlatform = process.platform;

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { configurable: true, value });
}

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('run_command', () => {
  test('Windows에서는 UTF-8 코드 페이지·인코딩을 먼저 맞추고 명령을 이어붙인다', async () => {
    setPlatform('win32');
    const { shellArgs } = await import('../src/tools/shell/runCommand.ts');
    const args = shellArgs('Get-Date');
    expect(args[0]).toBe('powershell.exe');
    const command = args.at(-1) ?? '';
    expect(command).toContain('chcp 65001');
    expect(command).toContain('[Console]::OutputEncoding');
    expect(command).toContain('$OutputEncoding');
    expect(command.endsWith('Get-Date')).toBe(true);
  });

  test('Windows가 아니면 손대지 않고 sh로 그대로 넘긴다', async () => {
    setPlatform('linux');
    const { shellArgs } = await import('../src/tools/shell/runCommand.ts');
    expect(shellArgs('echo hi')).toEqual(['/bin/sh', '-c', 'echo hi']);
  });
});

describe('start_process', () => {
  test('Windows에서는 UTF-8 코드 페이지·인코딩을 먼저 맞추고 명령을 이어붙인다', async () => {
    setPlatform('win32');
    const { shellArgs } = await import('../src/tools/shell/backgroundProcesses.ts');
    const command = shellArgs('bun run dev').at(-1) ?? '';
    expect(command).toContain('chcp 65001');
    expect(command.endsWith('bun run dev')).toBe(true);
  });

  test('Windows가 아니면 손대지 않고 sh로 그대로 넘긴다', async () => {
    setPlatform('linux');
    const { shellArgs } = await import('../src/tools/shell/backgroundProcesses.ts');
    expect(shellArgs('bun run dev')).toEqual(['/bin/sh', '-c', 'bun run dev']);
  });
});
