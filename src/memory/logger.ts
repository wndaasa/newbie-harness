import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDailyLogPath } from './paths.ts';
import type { LogRole } from './types.ts';

// 로그는 나중에 LLM 입력이 되므로 남기기 전에 자격 증명 형식을 가린다.
const SENSITIVE_PATTERNS = [
  // OpenAI(sk-proj-, sk-svcacct-)와 Anthropic(sk-ant-) 키는 sk- 뒤에도 하이픈이 있다
  /sk-[A-Za-z0-9_-]{10,}/g,
  /tvly-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
];

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]{3,}`/g;
const URL_RE = /https?:\/\/[^\s]{30,}/g;

// 기억 정리 분석에 무의미한 최대 길이 (문자 단위)
const MAX_USER_CHARS = 300;
// 어시스턴트 응답은 앞뒤를 남긴다. 제안·질문("원하시면 …", "진행할까요?")은 끝에
// 오므로 앞부분만 남기면 기억 정리가 사용자의 다음 말이 무엇에 대한 답인지 못 본다.
// 앞부분은 본문에서 정의한 용어("0단계" 등)를 잃지 않으려고 남긴다
const ASSISTANT_HEAD_CHARS = 100;
const ASSISTANT_TAIL_CHARS = 300;

function redact(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function isLoggingDisabled(): boolean {
  const v = process.env.NEWBIE_DISABLE_LOGGING ?? '';
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function hhMm(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// null 반환 시 로깅 건너뜀
function sanitizeForLog(role: LogRole, text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 슬래시 커맨드는 사용자 행동 패턴이 아님 — 제외
  if (role === 'user' && /^\/\w/.test(trimmed)) return null;

  if (role === 'assistant') {
    // 코드 블록·인라인 코드·긴 URL 제거 후 남은 텍스트가 핵심
    const stripped = trimmed
      .replace(CODE_BLOCK_RE, '[코드]')
      .replace(INLINE_CODE_RE, '[코드]')
      .replace(URL_RE, '[URL]')
      .replace(/\n+/g, ' ')
      .trim();

    // 제거 후 코드 플레이스홀더만 남으면 기록 불필요
    if (/^(\[코드\]\s*)+$/.test(stripped)) return null;

    return stripped.length > ASSISTANT_HEAD_CHARS + ASSISTANT_TAIL_CHARS
      ? `${stripped.slice(0, ASSISTANT_HEAD_CHARS)} … ${stripped.slice(-ASSISTANT_TAIL_CHARS)}`
      : stripped;
  }

  // user: 줄바꿈 정리 + 길이 제한
  const flat = trimmed.replace(/\n+/g, ' ');
  return flat.length > MAX_USER_CHARS
    ? `${flat.slice(0, MAX_USER_CHARS)}…`
    : flat;
}

export function appendToLog(role: LogRole, text: string): void {
  if (isLoggingDisabled()) return;

  const sanitized = sanitizeForLog(role, text);
  if (sanitized === null) return;

  const safe = redact(sanitized);
  const line = `- ${hhMm()} ${role}: ${safe}\n`;
  const logPath = getDailyLogPath();

  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line, 'utf8');
  } catch {
    // 로그 실패가 대화를 중단시키면 안 됨
  }
}
