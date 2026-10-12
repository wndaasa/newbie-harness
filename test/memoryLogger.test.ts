// 일별 로그에 남는 어시스턴트 응답의 절단 방식을 고정한다.
//
// 제안·질문은 응답 끝에 오는데, 앞 400자만 남기던 때는 긴 응답의 제안이 잘려
// /distill이 사용자의 다음 말("그렇게 해")이 무엇에 대한 답인지 알 수 없었다.
// 앞 100자와 뒤 300자를 남겨 주제와 제안을 함께 보존한다.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `newbie-memory-logger-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

const { appendToLog } = await import('../src/memory/logger.ts');
const { getDailyLogPath } = await import('../src/memory/paths.ts');

function reset() {
  rmSync(HOME, { recursive: true, force: true });
  delete process.env.NEWBIE_DISABLE_LOGGING;
}

beforeEach(reset);
afterEach(reset);

function loggedBody(): string {
  const line = readFileSync(getDailyLogPath(), 'utf8').trim();
  return line.replace(/^- \d{2}:\d{2} assistant: /, '');
}

test('긴 어시스턴트 응답은 앞 100자와 뒤 300자를 남기고 가운데를 생략한다', () => {
  const head = '가'.repeat(100);
  const middle = '나'.repeat(500);
  const tail = ' 원하시면 이렇게 고쳐 드릴게요.'.padStart(300, '다');
  appendToLog('assistant', `${head}${middle}${tail}`);

  expect(loggedBody()).toBe(`${head} … ${tail}`);
});

test('끝에 온 제안 문장이 로그에 남는다', () => {
  appendToLog('assistant', `조사 결과 설명입니다. ${'본문 '.repeat(200)}진행할까요?`);
  const body = loggedBody();
  expect(body.startsWith('조사 결과 설명입니다.')).toBe(true);
  expect(body.endsWith('진행할까요?')).toBe(true);
});

test('400자 이하 응답은 자르지 않는다', () => {
  const text = '라'.repeat(400);
  appendToLog('assistant', text);
  expect(loggedBody()).toBe(text);
});
