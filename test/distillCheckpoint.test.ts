// /distill 체크포인트·슬러그 방어 회귀 테스트.
//
// 결과가 비면 로그에 distilled 마커를 찍지 않아, 앱을 켤 때마다 같은
// 로그로 LLM을 다시 불렀다. 프롬프트가 "없으면 빈 배열"을 적극적으로 지시하므로
// 잡담뿐인 하루는 정상적으로 빈 결과를 낸다. 체크포인트 기준은 Kafka 오프셋
// 커밋과 같다 — "무엇을 저장했는가"가 아니라 "이 로그를 소비했는가".
//
// 그리고 LLM이 준 name이 검증 없이 파일 경로가 됐다.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = join(tmpdir(), `newbie-distill-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

// 프로바이더만 갈아끼우고 distill은 제품 코드 그대로 돌린다. 모듈 목 대신
// LM Studio 호환 로컬 서버를 세워 다른 테스트 파일의 모듈 레지스트리를 건드리지 않는다
let llmOutput = '';
let llmCalls = 0;

const server = Bun.serve({
  port: 0,
  fetch() {
    llmCalls += 1;
    const chunk = JSON.stringify({
      choices: [{ delta: { content: llmOutput } }],
    });
    return new Response(`data: ${chunk}

data: [DONE]

`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});

process.env.LM_STUDIO_BASE_URL = `http://127.0.0.1:${server.port}`;

const { getDailyLogPath, getMemoryBaseDir } = await import('../src/memory/paths.ts');
const { countUnprocessedLogFiles, distillUnprocessedLogs } = await import(
  '../src/memory/distill.ts'
);

const session = {
  mock: false,
  provider: 'lmstudio',
  model: 'test-model',
  maxTokens: 2048,
  messages: [],
} as any;

function writeLog(): string {
  const path = getDailyLogPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '- 09:00 user: 오늘 날씨가 좋네요 산책이나 할까 봐요\n', 'utf8');
  return path;
}

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  llmCalls = 0;
  llmOutput = '{"memories":[],"insights":[],"questions":[]}';
});

afterEach(() => rmSync(HOME, { recursive: true, force: true }));

afterAll(() => server.stop(true));

test('빈 결과라도 로그에 distilled 마커가 찍힌다', async () => {
  const logPath = writeLog();
  await distillUnprocessedLogs(session);

  expect(readFileSync(logPath, 'utf8')).toContain('<!-- distilled -->');
  expect(countUnprocessedLogFiles()).toBe(0);
});

test('두 번째 호출은 LLM을 다시 부르지 않는다', async () => {
  writeLog();
  await distillUnprocessedLogs(session);
  expect(llmCalls).toBe(1);

  const second = await distillUnprocessedLogs(session);
  expect(llmCalls).toBe(1); // 회귀의 본질 — 지금까지는 여기서 다시 불렀다
  expect(second.summary).toContain('이미 처리');
});

test('잘못된 슬러그 항목은 파일로 쓰이지 않는다', async () => {
  writeLog();
  llmOutput = JSON.stringify({
    memories: [
      {
        name: '../../Newbie',
        description: '경로 탈출 시도',
        type: 'user',
        body: '내용',
        source: 'confirmed',
      },
      {
        name: 'MEMORY',
        description: '인덱스 덮어쓰기 시도',
        type: 'user',
        body: '내용',
        source: 'confirmed',
      },
      {
        name: 'good-topic',
        description: '정상 항목',
        type: 'user',
        body: '내용',
        source: 'confirmed',
      },
    ],
    insights: [],
    questions: [],
  });

  const result = await distillUnprocessedLogs(session);

  expect(result.topicsWritten).toBe(1);
  expect(existsSync(join(getMemoryBaseDir(), 'good-topic.md'))).toBe(true);
  expect(existsSync(join(HOME, 'Newbie.md'))).toBe(false);
  // MEMORY.md는 인덱스로만 갱신되고 topic 본문으로 덮이지 않는다
  expect(readFileSync(join(getMemoryBaseDir(), 'MEMORY.md'), 'utf8')).toContain(
    '[good-topic](good-topic.md)',
  );
});
