// /checkin 커맨드의 저장 실패 처리 회귀 테스트.
//
// resolveQuestion의 boolean 반환을 두 호출자 모두 버려서, 저장이 실패해도
// "고마워요, 기억해둘게요"가 떴다. 실제로는 질문이 pending으로 남아 다음에
// 또 물어보고, 답변은 이미 당일 로그에 들어가 /distill이 두 번 소화했다.
//
// 순서가 핵심이다 — 큐 갱신이 성공한 뒤에만 로그로 환류한다.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `newbie-checkin-cmd-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

const { checkinCommand } = await import('../src/commands/builtins/checkin.ts');
const { appendPendingQuestions } = await import('../src/memory/questions.ts');
const { getDailyLogPath, getQuestionsPath } = await import('../src/memory/paths.ts');

function run(args: string) {
  const rows: any[] = [];
  checkinCommand.run({ appendRow: (row: any) => rows.push(row) } as any, args, '');
  return rows;
}

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  delete process.env.NEWBIE_DISABLE_LOGGING;
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  delete process.env.NEWBIE_DISABLE_LOGGING;
});

describe('질문 답변', () => {
  test('저장 성공 시에만 답변이 로그로 환류된다', () => {
    appendPendingQuestions([{ kind: 'topic-confirm', text: '프로젝트 X 끝났어?' }]);

    const rows = run('answer 응 지난주에 끝났어');

    expect(rows.at(-1)).toMatchObject({ role: 'system', content: '고마워요, 기억해둘게요.' });
    expect(readFileSync(getDailyLogPath(), 'utf8')).toContain('[확인 질문 답변]');
  });

  test('큐 저장 실패 시 오류를 표시하고 로그 환류를 하지 않는다', () => {
    appendPendingQuestions([{ kind: 'topic-confirm', text: '프로젝트 X 끝났어?' }]);
    // 읽기는 되고 쓰기만 막힌 상태 — 디스크가 차거나 파일이 잠긴 상황과 같다
    chmodSync(getQuestionsPath(), 0o444);

    try {
      const rows = run('answer 응 지난주에 끝났어');

      expect(rows.at(-1)).toMatchObject({ role: 'error' });
      // 저장 못 했으면 로그 환류도 하지 않는다 — /distill 이중 소화 방지
      expect(existsSync(getDailyLogPath())).toBe(false);
    } finally {
      chmodSync(getQuestionsPath(), 0o644);
    }
  });
});
