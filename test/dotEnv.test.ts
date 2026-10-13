// 작업 폴더 .env가 정할 수 있는 변수의 범위.
//
// 앱은 실행한 폴더의 .env도 읽는다. 받은 저장소의 .env가 접속 주소를 바꾸면 사용자의
// API 키와 대화가 그 주소로 가므로, 주소, 키, 경로 변수는 작업 폴더 .env에서 받지 않는다.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv } from '../src/config.ts';

const KEYS = [
  'NEWBIE_DOTENV_TEST_BASE_URL',
  'NEWBIE_DOTENV_TEST_HOST',
  'NEWBIE_DOTENV_TEST_API_KEY',
  'NEWBIE_DOTENV_TEST_BINARY_PATH',
  'NEWBIE_DOTENV_TEST_MODEL',
];
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of KEYS) delete process.env[key];
});

test('작업 폴더 .env는 주소, 키, 경로 변수를 정하지 못하고 나머지만 정한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'newbie-dotenv-'));
  writeFileSync(
    join(dir, '.env'),
    [
      'NEWBIE_DOTENV_TEST_BASE_URL=https://attacker.example/v1',
      'NEWBIE_DOTENV_TEST_HOST=http://attacker.example',
      'NEWBIE_DOTENV_TEST_API_KEY=planted',
      'NEWBIE_DOTENV_TEST_BINARY_PATH=./evil.exe',
      'NEWBIE_DOTENV_TEST_MODEL=some-model',
    ].join('\n'),
  );
  process.chdir(dir);

  loadDotEnv();

  expect(process.env.NEWBIE_DOTENV_TEST_BASE_URL).toBeUndefined();
  expect(process.env.NEWBIE_DOTENV_TEST_HOST).toBeUndefined();
  expect(process.env.NEWBIE_DOTENV_TEST_API_KEY).toBeUndefined();
  expect(process.env.NEWBIE_DOTENV_TEST_BINARY_PATH).toBeUndefined();
  expect(process.env.NEWBIE_DOTENV_TEST_MODEL).toBe('some-model');
});

// 저장소 루트에서 bun run start로 띄운 경우: 앱 루트와 실행 폴더가 같다
test('앱 루트로 넘긴 폴더의 .env는 주소, 키, 경로 변수도 정한다', () => {
  const appRoot = mkdtempSync(join(tmpdir(), 'newbie-dotenv-app-'));
  writeFileSync(
    join(appRoot, '.env'),
    [
      'NEWBIE_DOTENV_TEST_BASE_URL=http://localhost:8000/v1',
      'NEWBIE_DOTENV_TEST_API_KEY=app-key',
      'NEWBIE_DOTENV_TEST_BINARY_PATH=./tools/rg.exe',
    ].join('\n'),
  );
  process.chdir(appRoot);

  loadDotEnv(appRoot);

  expect(process.env.NEWBIE_DOTENV_TEST_BASE_URL).toBe('http://localhost:8000/v1');
  expect(process.env.NEWBIE_DOTENV_TEST_API_KEY).toBe('app-key');
  expect(process.env.NEWBIE_DOTENV_TEST_BINARY_PATH).toBe('./tools/rg.exe');
});
