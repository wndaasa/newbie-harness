// 자식 프로세스 환경의 비밀값 제거 회귀 테스트.
//
// 앱은 설정창에 저장한 API 키를 process.env에 얹는다. 그 환경을 그대로 물려주면
// run_command로 띄운 스크립트나 MCP 서버가 환경 변수 한 번 읽는 것으로 키를 가져간다.

import { describe, expect, test } from 'bun:test';
import { withoutStoredSecrets } from '../src/utils/secretEnv.ts';
import { nonInteractiveEnv } from '../src/tools/shell/nonInteractiveEnv.ts';

describe('비밀값 제거', () => {
  const env = {
    ANTHROPIC_API_KEY: 'a',
    GH_TOKEN: 'g',
    NEWBIE_SECRET_NOTION: 'n',
    OPENAI_API_KEY: 'o',
    PATH: '/usr/bin',
    TAVILY_API_KEY: 't',
    VLLM_API_KEY: 'v',
    openai_api_key: 'lower',
  };

  test('앱이 관리하는 키와 사용자 정의 비밀값을 뺀다', () => {
    const result = withoutStoredSecrets(env);
    // GH_TOKEN은 앱이 저장하지 않는 값이다. 사용자 셸의 것을 빼면 gh CLI 인증이 끊긴다
    expect(Object.keys(result)).toEqual(['GH_TOKEN', 'PATH']);
  });

  test('평범한 변수는 그대로 둔다', () => {
    expect(withoutStoredSecrets({ HOME: '/home/x', NODE_ENV: 'test' })).toEqual({
      HOME: '/home/x',
      NODE_ENV: 'test',
    });
  });

  test('셸·git 자식 프로세스 환경에도 적용된다', () => {
    const before = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const childEnv = nonInteractiveEnv();
      expect(childEnv.OPENAI_API_KEY).toBeUndefined();
      expect(childEnv.GIT_TERMINAL_PROMPT).toBe('0');
      expect(childEnv.PATH ?? childEnv.Path).toBeDefined();
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = before;
    }
  });
});
