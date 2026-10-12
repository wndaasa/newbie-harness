// 자식 프로세스에 물려주지 않을 비밀값 환경 변수.
//
// 앱은 설정창에 저장한 API 키를 시작할 때 process.env에 얹는다
// (app/main/credentials.ts의 applyStoredCredentials). 환경을 그대로 물려주면
// run_command로 띄운 스크립트나 stdio MCP 서버가 환경 변수 한 번 읽는 것으로
// 제공자 키를 가져갈 수 있다. 에이전트가 실행하는 코드에는 이 키가 필요 없으므로
// 넘기기 전에 걷어낸다.

const STORED_SECRET_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'LLAMACPP_API_KEY',
  'LM_STUDIO_API_KEY',
  'OPENAI_API_KEY',
  'TAVILY_API_KEY',
  'VLLM_API_KEY',
]);

/** 사용자가 설정창에서 이름을 정해 저장하는 비밀값의 접두사 (credentials.ts의 CUSTOM_PREFIX) */
const CUSTOM_SECRET_PREFIX = 'NEWBIE_SECRET_';

/** 앱이 관리하는 비밀값을 뺀 환경. Windows의 환경 변수 이름은 대소문자를 가리지 않는다 */
export function withoutStoredSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (STORED_SECRET_KEYS.has(upper) || upper.startsWith(CUSTOM_SECRET_PREFIX)) continue;
    result[key] = value;
  }
  return result;
}
