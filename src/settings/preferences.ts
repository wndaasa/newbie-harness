/*
 * 사용자 설정. 설정창에서 입력한 값이 시스템 프롬프트로 들어간다.
 *
 * 테마는 여기 없다. 테마는 첫 페인트 전에 정해져야 번쩍임이 없는데, 이 파일은
 * main 프로세스가 갖고 있어 렌더러가 읽으려면 IPC(비동기)를 타야 한다.
 * 그래서 테마만 렌더러의 localStorage에 남겨 뒀다(`app/renderer/src/theme.ts`).
 * 여기 있는 값은 전부 모델에게 보내는 것이라 한 턴 늦게 반영돼도 문제없다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getNewbieHome } from '../memory/globalNewbie.ts';

export const DEFAULT_AGENT_NAME = 'Newbie';

/** 이름은 한 줄이다. 프롬프트 한 줄에 그대로 박히므로 길이를 막는다 */
const MAX_NAME_CHARS = 40;
/** 지침은 매 턴 프롬프트에 실린다. Newbie.md(40k)보다 짧게 잡는다 */
const MAX_INSTRUCTIONS_CHARS = 8_000;

const PREFERENCES_FILE = 'preferences.json';

export type Preferences = {
  /** 모델이 사용자를 부를 이름 */
  userName: string;
  /** 모델이 스스로를 부를 이름. 빈 값은 "기본 이름을 쓴다"는 뜻 */
  agentName: string;
  /** 시스템 프롬프트 뒤에 붙는 사용자 지침 */
  instructions: string;
};

export const EMPTY_PREFERENCES: Preferences = {
  agentName: '',
  instructions: '',
  userName: '',
};

/**
 * 실제로 쓸 에이전트 이름.
 *
 * 저장할 때 기본값을 채워 넣지 않는 이유: 그러면 입력 칸을 비울 수가 없다.
 * 지웠다 저장하면 곧바로 "Newbie"가 되돌아와 자리끼움말이 뜰 틈이 없고,
 * "비워 두면 Newbie로 부릅니다"라는 안내가 거짓말이 된다.
 * 빈 값을 그대로 두고 쓰는 쪽에서 기본값을 정한다.
 */
export function resolveAgentName(preferences: Preferences): string {
  return preferences.agentName.trim() || DEFAULT_AGENT_NAME;
}

export function getPreferencesPath(): string {
  return join(getNewbieHome(), PREFERENCES_FILE);
}

export function readPreferences(): Preferences {
  const path = getPreferencesPath();
  if (!existsSync(path)) return { ...EMPTY_PREFERENCES };

  try {
    return sanitizePreferences(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // 파일이 깨졌다고 앱이 못 뜨면 안 된다. 기본값으로 계속 간다
    return { ...EMPTY_PREFERENCES };
  }
}

/** 넘긴 항목만 덮어쓰고, 저장된 전체 값을 돌려준다 */
export function writePreferences(patch: Partial<Preferences>): Preferences {
  const next = sanitizePreferences({ ...readPreferences(), ...patch });
  const path = getPreferencesPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** 어떤 값이 들어와도 Preferences 모양으로 만든다 (파일·IPC 양쪽 입구에서 쓴다) */
export function sanitizePreferences(raw: unknown): Preferences {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    agentName: cleanName(source.agentName),
    instructions: cleanText(source.instructions, MAX_INSTRUCTIONS_CHARS),
    userName: cleanName(source.userName),
  };
}

/** 이름은 한 줄로 접는다. 줄바꿈이 들어가면 프롬프트 구조가 깨진다 */
function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS);
}

function cleanText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

/**
 * 사용자를 어떻게 부를지 알린다.
 *
 * 이름을 안 적었으면 아무것도 넣지 않는다. "이름 없음" 같은 문장을 넣으면
 * 모델이 그걸 사실로 받아들여 굳이 이름을 물어보려 든다.
 */
export function formatUserProfile(preferences: Preferences): string {
  const name = preferences.userName.trim();
  if (!name) return '';
  return `The user's name is ${name}. Address them by this name when it fits naturally.`;
}

/** 설정창의 지침 칸. 형식은 Newbie.md 주입과 맞춘다 */
export function formatUserInstructions(preferences: Preferences): string {
  const instructions = preferences.instructions.trim();
  if (!instructions) return '';

  return [
    `## ${resolveAgentName(preferences)} 설정창 지침`,
    '사용자가 설정창에 직접 적은 지침입니다. 관련 있는 작업에서 지키세요.',
    '',
    instructions,
  ].join('\n');
}
