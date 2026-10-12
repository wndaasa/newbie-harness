/*
 * 제공자 오류를 사람이 읽을 수 있는 형태로 분류한다.
 *
 * 화면에 원문만 띄우면 무엇을 해야 하는지 알 수 없고(404 JSON을 보고 할 수 있는
 * 일은 없다), 반대로 원문을 지우고 친절한 문장만 남기면 더 나쁜 일이 생긴다 —
 * 403을 "API 키가 잘못됐다"로 옮기면 멀쩡한 키를 쓰는 사용자가 키를 새로
 * 발급받으러 간다. 403은 키가 받아들여졌다는 뜻이므로 인증 실패와 분리한다.
 *
 * 그래서 둘 다 낸다: 무엇이 잘못됐고 뭘 하면 되는지는 title이, 제공자가 실제로
 * 뭐라고 했는지는 detail이 맡는다. 화면은 detail을 접어 두고 필요할 때 편다.
 */
import { ProviderRequestError } from './fetchWithRetry.ts';

export type ErrorKind =
  | 'auth'
  | 'permission'
  | 'model-not-found'
  | 'quota'
  | 'rate-limit'
  | 'context-length'
  | 'content-filter'
  | 'network'
  | 'server'
  | 'unknown';

export type ErrorInfo = {
  kind: ErrorKind;
  /** 무엇이 잘못됐는지 한 줄. 화면 제목으로 쓴다 */
  title: string;
  /** 제공자가 실제로 보낸 문장. 없으면 빈 문자열 */
  detail: string;
};

/** 접어 둔 상세도 무한정 길 수는 없다. 프록시가 페이지를 통째로 보내는 일이 있다 */
const MAX_DETAIL_CHARS = 2_000;

const TITLES: Record<ErrorKind, string> = {
  auth: 'API 키가 거부되었습니다',
  permission: '제공자가 이 요청을 거부했습니다',
  'model-not-found': '모델을 찾을 수 없습니다',
  quota: '크레딧이나 할당량이 부족합니다',
  'rate-limit': '요청이 너무 잦습니다',
  'context-length': '대화가 모델의 컨텍스트 한도를 넘었습니다',
  'content-filter': '제공자가 안전 정책에 따라 응답을 거부했습니다',
  network: '제공자에 연결하지 못했습니다',
  server: '제공자 서버에 문제가 있습니다',
  unknown: '요청이 실패했습니다',
};

/**
 * 분류 결과를 오류 행 모양으로 만든다.
 *
 * 제공자를 직접 부르는 자리(슬래시 명령 등)가 여럿이라, 각자 문자열을 조립하면
 * 어떤 경로로 났느냐에 따라 화면이 달라진다 — 실제로 턴만 고쳤더니 /distill 같은
 * 명령에서는 옛 형식이 그대로 남았다.
 */
export function errorRow(error: unknown): {
  content: string;
  errorDetail: string;
  errorKind: string;
  role: 'error';
} {
  const info = classifyProviderError(error);
  return {
    content: info.title,
    errorDetail: info.detail,
    errorKind: info.kind,
    role: 'error',
  };
}

export function classifyProviderError(error: unknown): ErrorInfo {
  if (error instanceof ProviderRequestError) {
    const detail = providerMessage(error.body);
    const kind = kindFromStatus(error.status, detail) ?? kindFromText(detail) ?? 'unknown';
    return { detail, kind, title: titleFor(kind, error) };
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  const kind = kindFromText(message) ?? 'unknown';
  return { detail: clamp(message), kind, title: TITLES[kind] };
}

function titleFor(kind: ErrorKind, error: ProviderRequestError): string {
  // 게이트웨이·프록시가 HTML 오류 페이지를 돌려주면 본문에서 건질 문장이 없다.
  // 상태 코드만으로 분류하면 "인증 실패"처럼 엉뚱하게 단정하게 되므로 따로 알린다
  if (isHtml(error.body)) {
    return '제공자가 API 응답 대신 웹 페이지를 돌려줬습니다';
  }
  return TITLES[kind];
}

function kindFromStatus(status: number, detail: string): ErrorKind | null {
  if (status === 401) return 'auth';
  // 403은 키 자체는 받아들여졌다는 뜻이다. 지역 제한·플랜·권한 문제이므로
  // 인증 실패로 뭉뚱그리면 멀쩡한 키를 다시 발급받게 만든다
  if (status === 403) return 'permission';
  if (status === 402) return 'quota';
  if (status === 404) return 'model-not-found';
  if (status === 413) return 'context-length';
  if (status === 429) return /quota|credit|billing|insufficient/i.test(detail) ? 'quota' : 'rate-limit';
  if (status >= 500) return 'server';
  // 400은 원인이 여럿이라 상태만으로 못 정한다 — 본문을 보고 결정한다
  return null;
}

function kindFromText(text: string): ErrorKind | null {
  if (!text) return null;
  if (/context (length|window)|too long|maximum context|exceeds? the (available )?context/i.test(text)) {
    return 'context-length';
  }
  if (/content[_ ]filter|safety|refus/i.test(text)) return 'content-filter';
  if (/insufficient[_ ]quota|out of credit|billing|quota/i.test(text)) return 'quota';
  if (/rate[_ ]limit|too many requests/i.test(text)) return 'rate-limit';
  if (/model[_ ]not[_ ]found|unknown model|does not exist/i.test(text)) return 'model-not-found';
  if (/api[_ ]key|unauthorized|authentication/i.test(text)) return 'auth';
  if (/fetch failed|econnrefused|econnreset|enotfound|etimedout|network|timed? out/i.test(text)) {
    return 'network';
  }
  return null;
}

/**
 * 제공자가 보낸 본문에서 사람이 읽을 문장만 꺼낸다.
 *
 * 잡아 둔 예외를 그대로 문자열로 만들면 안 된다 — 파일 경로와 내부 서비스 주소가
 * 화면으로 새어 나올 수 있다. 여기서는 응답 본문에서 알려진 자리만 꺼내고, 못
 * 찾으면 본문을 잘라서 쓴다.
 */
function providerMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  if (isHtml(trimmed)) return '';

  try {
    const found = findMessage(JSON.parse(trimmed), 0);
    if (found) return clamp(found);
  } catch {
    // JSON이 아니면 본문 자체가 곧 메시지다
  }
  return clamp(trimmed);
}

/** 제공자마다 메시지를 묻어 두는 깊이가 달라 몇 겹만 따라 들어간다 */
function findMessage(value: unknown, depth: number): string {
  if (typeof value === 'string') return value.trim();
  if (depth > 3 || value === null || typeof value !== 'object') return '';

  const source = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'msg', 'reason']) {
    if (!(key in source)) continue;
    const found = findMessage(source[key], depth + 1);
    if (found) return found;
  }
  return '';
}

function isHtml(body: string): boolean {
  return /^\s*(<!doctype|<html)/i.test(body);
}

function clamp(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…`
    : trimmed;
}
