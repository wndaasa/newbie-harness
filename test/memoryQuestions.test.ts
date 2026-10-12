// 확인 질문 큐 회귀 테스트.
//
// 큐는 append-only 이벤트 로그다. CLI와 펫이 동시에 떠 있는 것이 제품의 전제라
// 전체 파일 read-modify-write는 갱신을 유실시킨다. 해소·만료 처리는 fold가
// 담당하므로 별도 정리 코드가 없다.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = join(tmpdir(), `newbie-questions-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

const { getQuestionsPath } = await import('../src/memory/paths.ts');
const {
  appendPendingQuestions,
  countPendingQuestions,
  getNextPendingQuestion,
  resolveQuestion,
} = await import('../src/memory/questions.ts');

const q = (text: string) => ({ kind: 'topic-confirm' as const, text });

function lines(): string[] {
  return readFileSync(getQuestionsPath(), 'utf8').trim().split('\n').filter(Boolean);
}

beforeEach(() => rmSync(HOME, { recursive: true, force: true }));
afterEach(() => rmSync(HOME, { recursive: true, force: true }));

describe('fold', () => {
  test('파일이 없으면 빈 큐로 동작한다', () => {
    expect(getNextPendingQuestion()).toBeNull();
    expect(countPendingQuestions()).toBe(0);
  });

  test('가장 오래된 pending이 먼저 나온다', () => {
    appendPendingQuestions([q('첫째'), q('둘째')]);
    expect(getNextPendingQuestion()?.text).toBe('첫째');
  });

  test('resolved 이벤트가 있는 질문은 다시 나오지 않는다', () => {
    appendPendingQuestions([q('첫째'), q('둘째')]);
    const first = getNextPendingQuestion()!;
    resolveQuestion(first.id, 'answered');

    expect(getNextPendingQuestion()!.id).not.toBe(first.id);
    expect(getNextPendingQuestion()!.text).toBe('둘째');
    expect(countPendingQuestions()).toBe(1);
  });

  test('7일 지난 질문은 조용히 만료된다', () => {
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    mkdirSync(dirname(getQuestionsPath()), { recursive: true });
    writeFileSync(
      getQuestionsPath(),
      JSON.stringify({
        ts: old,
        event: 'created',
        id: 'old-1',
        kind: 'topic-confirm',
        text: '오래된 질문',
        relatedTopic: '',
      }) + '\n',
      'utf8',
    );

    expect(getNextPendingQuestion()).toBeNull();
  });

  test('깨진 줄이 있어도 나머지 이벤트를 읽는다', () => {
    appendPendingQuestions([q('살아있는 질문')]);
    appendFileSync(getQuestionsPath(), '{깨진 JSON\n', 'utf8');

    expect(getNextPendingQuestion()?.text).toBe('살아있는 질문');
  });
});

describe('동시 쓰기', () => {
  test('두 writer가 번갈아 append해도 서로를 덮어쓰지 않는다', () => {
    // 이전 구조(전체 read-modify-write)에서는 여기서 갱신이 유실됐다:
    // 펫이 q1을 해소하는 사이 CLI가 추가한 질문이 통째로 사라졌다
    appendPendingQuestions([q('CLI-1')]);
    const first = getNextPendingQuestion()!;

    // 펫이 자기 스냅샷을 들고 있는 동안 CLI가 새 질문을 추가
    appendPendingQuestions([q('CLI-2'), q('CLI-3')]);
    // 펫은 자기 이벤트만 덧붙인다
    resolveQuestion(first.id, 'answered');

    expect(countPendingQuestions()).toBe(2);
    expect([getNextPendingQuestion()!.text]).toEqual(['CLI-2']);
  });
});

describe('컴팩션', () => {
  test('해소된 질문은 컴팩션 후 파일에서 사라진다', () => {
    appendPendingQuestions([q('첫째')]);
    resolveQuestion(getNextPendingQuestion()!.id, 'answered');
    appendPendingQuestions([q('둘째')]); // 컴팩션 트리거

    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0]).text).toBe('둘째');
  });

  test('컴팩션이 원래 생성 시각을 보존한다', () => {
    // 다시 쓰면서 ts를 현재 시각으로 갱신하면 7일 만료가 영영 오지 않는다
    appendPendingQuestions([q('첫째')]);
    const createdAt = getNextPendingQuestion()!.createdAt;
    appendPendingQuestions([q('둘째')]);

    expect(getNextPendingQuestion()!.createdAt).toBe(createdAt);
  });

  test('7일 지난 pending도 컴팩션 대상이다', () => {
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    mkdirSync(dirname(getQuestionsPath()), { recursive: true });
    writeFileSync(
      getQuestionsPath(),
      JSON.stringify({
        ts: old,
        event: 'created',
        id: 'old-1',
        kind: 'topic-confirm',
        text: '오래된 질문',
        relatedTopic: '',
      }) + '\n',
      'utf8',
    );

    appendPendingQuestions([q('새 질문')]);
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0]).text).toBe('새 질문');
  });
});

describe('쓰기 실패', () => {
  test('저장하지 못하면 예외를 던진다', () => {
    // 큐 파일 자리를 디렉터리로 막아 append를 실패시킨다
    mkdirSync(getQuestionsPath(), { recursive: true });
    expect(existsSync(getQuestionsPath())).toBe(true);

    expect(() => resolveQuestion('any-id', 'answered')).toThrow();
    expect(() => appendPendingQuestions([q('실패')])).toThrow();
  });
});
