// 펫이 로깅 정책을 지키는지 고정한다.
//
// 펫은 src/memory/logger.ts의 규약을 손으로 복제했고, 그 복제본은 이미
// 어긋나 있었다 — NEWBIE_DISABLE_LOGGING 확인도, 민감 패턴 마스킹도, 길이
// 제한도 없었다. 사용자가 로깅을 껐는데도 펫은 계속 기록했고, 확인 질문
// 답변란에 붙여넣은 API 키가 평문으로 남아 다음 /distill에서 LLM으로 갔다.
//
// 이제 펫과 CLI가 같은 appendToLog를 쓰므로, 펫이 남기는 두 종류의 줄
// (체크인·확인 질문 답변)에 정책이 실제로 걸리는지 확인한다.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `newbie-pet-logging-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

const { appendToLog } = await import('../src/memory/logger.ts');
const { getDailyLogPath } = await import('../src/memory/paths.ts');

function reset() {
  rmSync(HOME, { recursive: true, force: true });
  delete process.env.NEWBIE_DISABLE_LOGGING;
}

beforeEach(reset);
afterEach(reset);

test('NEWBIE_DISABLE_LOGGING=1이면 펫 답변도 기록되지 않는다', () => {
  process.env.NEWBIE_DISABLE_LOGGING = '1';
  appendToLog('user', '[확인 질문 답변] Q: 프로젝트 X 끝났어? A: 응');
  expect(existsSync(getDailyLogPath())).toBe(false);
});

test('NEWBIE_DISABLE_LOGGING=1이면 펫 체크인도 기록되지 않는다', () => {
  process.env.NEWBIE_DISABLE_LOGGING = '1';
  appendToLog('user', '[체크인] 기분 7/10');
  expect(existsSync(getDailyLogPath())).toBe(false);
});

test('펫 답변에 섞인 API 키가 마스킹된다', () => {
  appendToLog('user', '[확인 질문 답변] Q: 키 뭐 써? A: sk-abcdefghijklmnop');
  const logged = readFileSync(getDailyLogPath(), 'utf8');
  expect(logged).toContain('[REDACTED]');
  expect(logged).not.toContain('sk-abcdefghijklmnop');
});

test('펫이 남긴 줄도 길이 제한을 받는다', () => {
  appendToLog('user', `[확인 질문 답변] A: ${'가'.repeat(500)}`);
  const logged = readFileSync(getDailyLogPath(), 'utf8').trim();
  expect(logged.length).toBeLessThan(400);
  expect(logged.endsWith('…')).toBe(true);
});
