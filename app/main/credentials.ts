/*
 * 제공자 자격 증명 저장소.
 *
 * 설치본은 프로그램 폴더 아래에 들어가 .env를 둘 자리가 없다. 그래서 설정창에서
 * 넣은 키는 사용자 홈(~/.newbie)에 저장하는데, 평문으로 두면 백업·동기화 폴더·
 * 화면 공유로 파일 하나만 새도 그대로 유출된다. Electron safeStorage로 감싸면
 * Windows DPAPI가 그 사용자·그 기계 밖에서는 복호화하지 못하게 막는다. 같은
 * 계정으로 도는 악성 코드까지 막아 주지는 않는다 — 유출 반경을 줄이는 장치다.
 *
 * 이 파일이 src/가 아니라 app/main/에 있는 이유: src/에는 electron import가 한
 * 건도 없고 scripts/smoke.ts와 bun test가 src/config.ts를 Node로 직접 불러 쓴다.
 * 거기에 electron을 끌어들이면 그 경로가 통째로 깨진다.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';
import { DEFAULT_PROVIDER, PROVIDERS } from '../../src/config.ts';
import { SAMPLING_KEYS } from '../../src/providers/sampling.ts';
import { getNewbieHome } from '../../src/memory/globalNewbie.ts';
import { getMcpAuthDir, setMcpCredentialVault } from '../../src/mcp/oauth.ts';
import type { McpCredentialVault } from '../../src/mcp/oauth.ts';

const CREDENTIALS_FILE = 'credentials.enc';

/**
 * 설정창이 다루는 환경 변수. 여기 없는 이름은 저장하지도 읽지도 않는다.
 *
 * 제공자·모델도 여기 있다. 모델 칩으로 바꾼 값은 그 세션에만 남고(controller의
 * persistConfig), 앱은 켤 때마다 새 대화로 시작하므로(config.ts의 createSession은
 * resume/continue 인자가 있을 때만 복원한다) 저장할 곳이 따로 필요하다.
 */
const KEYS = [
  'NEWBIE_PROVIDER',
  'ANTHROPIC_MODEL',
  'OPENAI_MODEL',
  'OLLAMA_MODEL',
  'LM_STUDIO_MODEL',
  'LLAMACPP_MODEL',
  'VLLM_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OLLAMA_HOST',
  'LM_STUDIO_BASE_URL',
  'LLAMACPP_BASE_URL',
  'VLLM_BASE_URL',
  // vLLM은 다른 로컬 제공자와 달리 주소와 키가 둘 다 필요하다
  'VLLM_API_KEY',
  // web_search 도구가 부를 때마다 환경에서 읽는다 (src/websearch/tavily.ts).
  // 설치본에는 .env를 둘 자리가 없어, 여기 없으면 웹 검색을 켤 방법이 없었다
  'TAVILY_API_KEY',
  // 샘플링 값. 제공자가 요청할 때 환경에서 읽는다 (src/providers/sampling.ts)
  ...SAMPLING_KEYS,
] as const;

export type CredentialKey = (typeof KEYS)[number];


/** 화면으로 값을 되돌려주지 않고 마스킹만 보내는 항목 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'VLLM_API_KEY',
  'TAVILY_API_KEY',
]);

/** API 키·URL은 길어야 수백 자다. 깨진 입력이 파일을 부풀리지 않게 막는다 */
const MAX_VALUE_CHARS = 4_000;

/**
 * 사용자가 직접 이름을 정하는 비밀값의 접두사.
 *
 * MCP 서버 설정(~/.newbie/mcp.json)은 평문 파일이라 토큰을 그대로 적으면
 * 그대로 샌다. 그 파일은 ${VAR} 치환을 지원하므로(src/mcp/config.ts) 값만
 * 여기 암호화해 두고 파일에는 이름만 적으면 된다.
 *
 * 접두사를 강제하는 이유: 임의의 이름을 받으면 PATH 같은 시스템 변수를
 * 덮어쓸 수 있다. 이 접두사 아래에서만 만들게 한다.
 */
const CUSTOM_PREFIX = 'NEWBIE_SECRET_';
/** 이름은 환경 변수로 나가므로 셸이 받아들이는 문자만 */
const CUSTOM_NAME = /^[A-Z0-9_]{1,60}$/;

type StoredCredentials = Record<string, string>;

export type CredentialField = {
  key: CredentialKey;
  secret: boolean;
  /** 비밀 항목은 마스킹된 표시용 문자열, 나머지는 실제 값 */
  value: string;
  /** 저장소든 환경이든 어딘가에 값이 있는지 */
  present: boolean;
  /** .env나 환경 변수가 이미 잡고 있어 저장값이 무시되는 상태 */
  overriddenByEnv: boolean;
};

export type CredentialState = {
  /** OS 자격 증명 저장소를 쓸 수 있는지. false면 저장이 거부된다 */
  available: boolean;
  fields: CredentialField[];
  /** 사용자가 만든 비밀값 (MCP 설정의 ${VAR}에 쓴다). 값은 마스킹만 */
  custom: { name: string; masked: string }[];
  /** 사용자 정의 이름에 붙는 접두사 — 화면이 안내에 쓴다 */
  customPrefix: string;
  /** 기본 제공자 선택지. 렌더러가 목록을 따로 갖지 않도록 여기서 넘긴다 */
  providers: string[];
};

/**
 * applyStoredCredentials 시점에 이미 환경에 있던 키.
 *
 * 리포의 .env와 실제 환경 변수가 저장소보다 우선한다. 개발 중에는 지금까지처럼
 * .env가 이기고, .env가 없는 설치본에서는 저장소가 유일한 출처가 된다.
 */
const envOwned = new Set<string>();

export function getCredentialsPath(): string {
  return join(getNewbieHome(), CREDENTIALS_FILE);
}

/**
 * 저장된 값을 환경의 빈 칸에만 얹는다.
 *
 * safeStorage는 앱 준비 이후에만 쓸 수 있으므로 whenReady 안에서, 그리고
 * createSession보다 먼저 불러야 시작 제공자·모델에 저장값이 반영된다.
 *
 * 시작할 때 한 번만 부르는 함수다. 두 번 부르면 첫 호출이 환경에 얹은 저장값을
 * 다음 호출이 envOwned로 잡아, 설정창에서 그 줄이 잘못 잠긴다.
 */
export function applyStoredCredentials(): void {
  const stored = readStored();
  // 사용자가 만든 값도 환경에 얹는다 — mcp.json의 ${VAR} 치환이 이걸 읽는다
  for (const key of [...KEYS, ...Object.keys(stored).filter(isCustomKey)]) {
    if (process.env[key]) {
      envOwned.add(key);
      continue;
    }
    const value = stored[key];
    if (value) process.env[key] = value;
  }
}

export function readCredentialState(): CredentialState {
  const stored = readStored();
  return {
    available: safeStorage.isEncryptionAvailable(),
    customPrefix: CUSTOM_PREFIX,
    custom: Object.keys(stored)
      .filter(isCustomKey)
      .sort()
      .map(key => ({ name: key, masked: maskSecret(stored[key] ?? '') })),
    providers: [...PROVIDERS],
    fields: KEYS.map(key => {
      const secret = SECRET_KEYS.has(key);
      // 제공자는 비어 있을 수 없다 — 아무것도 없으면 createSession이 쓰는 값과
      // 같은 기본값을 보여줘야 설정창이 실제 동작과 어긋나지 않는다
      const fallback = key === 'NEWBIE_PROVIDER' ? DEFAULT_PROVIDER : '';
      // ??가 아니라 ||인 이유는 config.ts의 createSession과 같다 — 빈 문자열도
      // "안 정한 것"으로 봐야 한다. ??로 두면 NEWBIE_PROVIDER=인 환경에서
      // 빈 값이 그대로 내려가 어느 제공자도 선택되지 않은 화면이 나온다
      const effective = process.env[key] || stored[key] || fallback;
      return {
        key,
        secret,
        // 비밀값은 렌더러로 내리지 않는다. 답변의 링크를 눌러 창이 외부 페이지로
        // 갈 수 있다는 전제(index.ts의 will-navigate 주석)에서는 화면 프로세스에
        // 키를 두지 않는 편이 일관된다
        value: secret ? maskSecret(effective) : effective,
        present: effective !== '',
        overriddenByEnv: envOwned.has(key),
      };
    }),
  };
}

/** 넘긴 항목만 덮어쓰고, 빈 값은 지움으로 본다 */
export function saveCredentials(patch: unknown): CredentialState {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS 자격 증명 저장소를 쓸 수 없어 키를 저장할 수 없습니다. 환경 변수나 .env를 사용하세요.',
    );
  }

  const next: StoredCredentials = { ...readStored(), ...sanitize(patch) };
  const allKeys = [...KEYS, ...Object.keys(next).filter(isCustomKey)];
  for (const key of allKeys) {
    if (!next[key]) delete next[key];
  }

  const path = getCredentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });

  // 제공자들이 요청할 때마다 process.env를 읽으므로(providers/types.ts의
  // requireApiKey) 여기서 환경만 맞춰 주면 재시작 없이 다음 턴부터 적용된다
  for (const key of allKeys) {
    if (envOwned.has(key)) continue;
    if (next[key]) process.env[key] = next[key];
    else delete process.env[key];
  }

  return readCredentialState();
}

function readStored(): StoredCredentials {
  const path = getCredentialsPath();
  if (!existsSync(path)) return {};

  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    return sanitize(JSON.parse(safeStorage.decryptString(readFileSync(path))));
  } catch {
    // 다른 기계·다른 계정에서 복사돼 온 파일은 복호화되지 않는다. 앱이 못 뜨는
    // 것보다 키가 비어 있는 편이 낫다 — 설정창에서 다시 넣으면 덮어써진다
    return {};
  }
}

function isCustomKey(key: string): boolean {
  return key.startsWith(CUSTOM_PREFIX) && CUSTOM_NAME.test(key.slice(CUSTOM_PREFIX.length));
}

/** 저장소가 다루는 이름 전체 — 고정 목록 + 사용자가 만든 것 */
function knownKeys(source: Record<string, unknown>): string[] {
  return [...KEYS, ...Object.keys(source).filter(isCustomKey)];
}

/** 어떤 값이 들어와도 저장 가능한 모양으로 만든다 (파일·IPC 양쪽 입구에서 쓴다) */
function sanitize(raw: unknown): StoredCredentials {
  const source = (raw ?? {}) as Record<string, unknown>;
  const result: StoredCredentials = {};
  for (const key of knownKeys(source)) {
    if (!(key in source)) continue;
    const value = source[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().slice(0, MAX_VALUE_CHARS);

    // 모르는 제공자가 저장소에 들어가면 createSession의 normalizeProvider가
    // 예외를 던지고 앱이 시작조차 못 한다 — 설정창을 열 수 없으니 되돌릴 방법도
    // 없다. 파일에서 읽을 때도 이 함수를 타므로 여기서 한 번에 막는다.
    // (빈 값은 "지움"이라 통과시킨다)
    if (key === 'NEWBIE_PROVIDER' && trimmed) {
      const normalized = trimmed.toLowerCase();
      if (!PROVIDERS.includes(normalized)) continue;
      result[key] = normalized;
      continue;
    }

    result[key] = trimmed;
  }
  return result;
}

/** 키가 들어 있다는 사실과 어느 키인지만 알아볼 수 있을 만큼만 남긴다 */
function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}${'•'.repeat(6)}${value.slice(-4)}`;
}

/*
 * ── MCP OAuth 토큰 저장소 ─────────────────────────────────────
 *
 * MCP 서버 승인을 마치면 액세스·리프레시 토큰이 돌아온다. src/mcp/oauth.ts의
 * 기본 구현은 이것을 ~/.newbie/mcp-auth/<서버>.json에 평문으로 적는데, 파일
 * 권한(0o600)은 Windows에서 무시되므로 사실상 아무 보호가 없다. 리프레시
 * 토큰은 만료된 액세스 토큰을 계속 새로 받아 오는 열쇠라 사실상 무기한이고,
 * 파일 하나만 새면 이 앱 없이도 사용자의 계정에 요청을 보낼 수 있다.
 *
 * 설정창에서 넣은 API 키를 암호화해 두면서 앱이 스스로 받아 온 토큰만 평문으로
 * 두는 것은 앞뒤가 맞지 않아, 같은 safeStorage 저장소로 옮긴다.
 */

const MCP_TOKENS_FILE = 'mcp-auth.enc';

type McpTokenStore = Record<string, string>;

function mcpTokensPath(): string {
  return join(getNewbieHome(), MCP_TOKENS_FILE);
}

function readMcpTokens(): McpTokenStore {
  const path = mcpTokensPath();
  if (!existsSync(path)) return {};
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const parsed: unknown = JSON.parse(safeStorage.decryptString(readFileSync(path)));
    if (!parsed || typeof parsed !== 'object') return {};
    // 값이 문자열이 아니면 oauth.ts가 JSON.parse에서 터진다 — 여기서 걸러 낸다
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, value]) => typeof value === 'string',
      ),
    ) as McpTokenStore;
  } catch (error) {
    // 다른 기계에서 복사돼 온 파일은 복호화되지 않는다. 앱이 못 뜨는 것보다
    // 다시 인증받는 편이 낫다 — MCP 탭의 인증 버튼이 그 길이다.
    // 조용히 넘기면 "토큰은 있는데 인증 필요로 뜬다"는 상태를 알아볼 방법이
    // 없어서 로그는 남긴다
    console.warn(`[mcp] 저장된 승인을 읽지 못했습니다: ${String(error)}`);
    return {};
  }
}

function writeMcpTokens(store: McpTokenStore): void {
  const path = mcpTokensPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, safeStorage.encryptString(JSON.stringify(store)), { mode: 0o600 });
}

const encryptedMcpVault: McpCredentialVault = {
  read: name => readMcpTokens()[name],
  write(name, json) {
    writeMcpTokens({ ...readMcpTokens(), [name]: json });
  },
  remove(name) {
    const store = readMcpTokens();
    delete store[name];
    writeMcpTokens(store);
  },
  has: name => readMcpTokens()[name] !== undefined,
};

/**
 * 암호화 저장소를 MCP OAuth 저장소로 꽂고, 남아 있는 평문 파일을 옮긴다.
 *
 * connectMcpServers보다 먼저 불러야 한다 — 연결이 시작되면 저장소를 읽는다.
 * safeStorage를 못 쓰는 환경(리눅스 일부)에서는 아무것도 하지 않고 기존 파일
 * 저장소를 그대로 둔다. 토큰을 잃는 것보다 낫다.
 */
export function installEncryptedMcpVault(): void {
  if (!safeStorage.isEncryptionAvailable()) return;
  migratePlaintextMcpTokens();
  setMcpCredentialVault(encryptedMcpVault);
}

/**
 * 예전 평문 파일을 암호화 저장소로 옮기고 원본을 지운다.
 *
 * 암호화해 넣고 다시 읽어 값이 같은지 확인한 뒤에만 원본을 지운다 — 저장이
 * 실패한 채로 지우면 승인이 통째로 날아간다.
 */
function migratePlaintextMcpTokens(): void {
  const dir = getMcpAuthDir();
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(name => name.endsWith('.json'));
  } catch {
    return;
  }
  if (files.length === 0) return;

  const moved: string[] = [];
  const store = readMcpTokens();
  for (const file of files) {
    const name = file.slice(0, -'.json'.length);
    // 이미 암호화 저장소에 있는 서버는 그쪽이 최신이다 — 덮어쓰지 않는다
    if (store[name] !== undefined) {
      moved.push(file);
      continue;
    }
    try {
      store[name] = readFileSync(join(dir, file), 'utf8');
      moved.push(file);
    } catch {
      // 읽지 못한 파일은 손대지 않고 남겨 둔다
    }
  }
  if (moved.length === 0) return;

  try {
    writeMcpTokens(store);
    const verified = readMcpTokens();
    for (const file of moved) {
      const name = file.slice(0, -'.json'.length);
      if (verified[name] === store[name]) rmSync(join(dir, file), { force: true });
    }
    // 남은 것이 없으면 폴더도 치운다. 뭔가 남아 있으면 실패하고 그대로 둔다
    try {
      rmdirSync(dir);
    } catch {
      // 옮기지 못한 파일이 남아 있는 경우 — 그대로 두는 것이 맞다
    }
  } catch {
    // 암호화 저장에 실패하면 평문 파일을 그대로 둔다. 승인을 잃지 않는 쪽이 낫다
  }
}
