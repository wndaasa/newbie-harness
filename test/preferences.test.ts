// 설정창 값 저장·프롬프트 주입 회귀 테스트.
//
// NEWBIE_HOME을 임시 경로로 돌려 실제 사용자 데이터(~/.newbie)와 격리한다.
// preferences 모듈은 import 시점이 아니라 호출 시점에 경로를 계산한다.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = join(tmpdir(), `newbie-prefs-test-${process.pid}`);
process.env.NEWBIE_HOME = HOME;

const {
  DEFAULT_AGENT_NAME,
  formatUserInstructions,
  formatUserProfile,
  getPreferencesPath,
  readPreferences,
  resolveAgentName,
  sanitizePreferences,
  writePreferences,
} = await import('../src/settings/preferences.ts');

beforeEach(() => {
  rmSync(HOME, { force: true, recursive: true });
  mkdirSync(HOME, { recursive: true });
});

afterAll(() => {
  rmSync(HOME, { force: true, recursive: true });
});

describe('sanitizePreferences', () => {
  test('빈 값이면 전부 빈 문자열이다', () => {
    // 여기서 기본 이름을 채워 넣으면 입력 칸을 비울 수가 없어진다
    expect(sanitizePreferences({})).toEqual({
      agentName: '',
      instructions: '',
      userName: '',
    });
  });

  test('이름의 줄바꿈은 한 줄로 접는다', () => {
    // 이름이 여러 줄이면 프롬프트 구조가 깨진다
    const result = sanitizePreferences({ userName: '홍\n길동  입니다' });
    expect(result.userName).toBe('홍 길동 입니다');
  });

  test('에이전트 이름이 공백뿐이면 빈 값으로 저장된다', () => {
    expect(sanitizePreferences({ agentName: '   ' }).agentName).toBe('');
  });

  test('이름 길이를 40자로 자른다', () => {
    expect(sanitizePreferences({ userName: 'a'.repeat(100) }).userName).toHaveLength(40);
  });

  test('지침 길이를 8000자로 자른다', () => {
    expect(sanitizePreferences({ instructions: '가'.repeat(9000) }).instructions).toHaveLength(
      8000,
    );
  });

  test('문자열이 아닌 값이 와도 통과시키지 않는다', () => {
    const result = sanitizePreferences({ agentName: 42, instructions: null, userName: {} });
    expect(result).toEqual({ agentName: '', instructions: '', userName: '' });
  });
});

describe('resolveAgentName', () => {
  test('비어 있으면 기본 이름을 쓴다', () => {
    expect(resolveAgentName(sanitizePreferences({}))).toBe(DEFAULT_AGENT_NAME);
  });

  test('적어 두면 그 이름을 쓴다', () => {
    expect(resolveAgentName(sanitizePreferences({ agentName: '뉴비' }))).toBe('뉴비');
  });
});

describe('읽기·쓰기', () => {
  test('파일이 없으면 빈 값을 준다', () => {
    expect(existsSync(getPreferencesPath())).toBe(false);
    expect(readPreferences()).toEqual({ agentName: '', instructions: '', userName: '' });
  });

  test('저장한 값을 그대로 읽는다', () => {
    writePreferences({ instructions: '한국어로 답해줘', userName: '홍길동' });
    const stored = readPreferences();
    expect(stored.userName).toBe('홍길동');
    expect(stored.instructions).toBe('한국어로 답해줘');
  });

  test('넘긴 항목만 덮어쓴다', () => {
    writePreferences({ agentName: '뉴비', userName: '홍길동' });
    writePreferences({ userName: '지수' });
    const stored = readPreferences();
    expect(stored.userName).toBe('지수');
    expect(stored.agentName).toBe('뉴비');
  });

  test('파일이 깨져 있어도 기본값으로 계속 간다', () => {
    // 설정 파일 하나 때문에 앱이 못 뜨면 안 된다
    writeFileSync(getPreferencesPath(), '{ 이건 JSON이 아님', 'utf8');
    expect(readPreferences()).toEqual({ agentName: '', instructions: '', userName: '' });
    expect(resolveAgentName(readPreferences())).toBe(DEFAULT_AGENT_NAME);
  });
});

describe('프롬프트 주입', () => {
  test('이름을 적으면 사용자 이름 줄이 생긴다', () => {
    const text = formatUserProfile(sanitizePreferences({ userName: '홍길동' }));
    expect(text).toContain('홍길동');
  });

  test('이름이 없으면 아무것도 넣지 않는다', () => {
    // "이름 없음" 같은 문장을 넣으면 모델이 이름을 물어보려 든다
    expect(formatUserProfile(sanitizePreferences({}))).toBe('');
  });

  test('지침을 적으면 본문이 그대로 실린다', () => {
    const text = formatUserInstructions(
      sanitizePreferences({ instructions: '항상 한국어로 답해줘' }),
    );
    expect(text).toContain('항상 한국어로 답해줘');
  });

  test('지침이 비면 아무것도 넣지 않는다', () => {
    expect(formatUserInstructions(sanitizePreferences({ instructions: '  ' }))).toBe('');
  });

  test('지침 안내문에 설정한 에이전트 이름을 쓴다', () => {
    const text = formatUserInstructions(
      sanitizePreferences({ agentName: '뉴비', instructions: '규칙' }),
    );
    expect(text).toContain('뉴비');
  });
});
