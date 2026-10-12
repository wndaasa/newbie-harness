// 세션 제목 자동 생성.
//
// 사이드바 제목은 사용자가 직접 짓지 않으면 첫 메시지를 80자로 자른 것이라,
// 마크다운 문서를 붙여넣으면 "# 제목 ## 1. 용어 - **AUC**..." 같은 원문
// 조각이 그대로 노출됐다. 첫 턴이 끝난 뒤 백그라운드로 모델에게 짧은
// 제목을 짓게 해 세션 이름으로 저장한다. 제목은 장식이므로 실패해도 조용히
// 기존 폴백(firstPrompt)으로 남긴다.

import { runProviderText } from '../providers/index.ts';
import type { Session } from './types.ts';

const MAX_TITLE_CHARS = 40;
/** 제목 재료로 넘길 본문 길이. 길게 줘봐야 제목 품질보다 비용만 는다 */
const MAX_SOURCE_CHARS = 500;

/**
 * 이 턴이 끝난 뒤 제목을 지을 대상인가.
 *
 * 첫 사용자 턴 직후에만 짓는다. 재개한 세션(사용자 메시지 2개 이상)은 이미
 * 제목이 있거나 사용자가 직접 지은 이름일 수 있어 덮어쓰지 않는다.
 */
export function shouldAutoTitleSession(session: Session): boolean {
  if (session.mock) return false;
  return session.messages.filter(message => message.role === 'user').length === 1;
}

/** 모델 출력에서 제목 한 줄만 추려 정리함 (따옴표·서식 기호·군말 제거) */
export function sanitizeTitle(raw: string): string {
  const firstLine =
    String(raw ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)[0] ?? '';
  return firstLine
    .replace(/^제목\s*[:：]\s*/, '')
    // _는 벗기지 않는다 — run_experiment.py 같은 식별자가 제목에 흔히 들어간다
    .replace(/["'`“”‘’*#]/g, '')
    .replace(/[.。!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

function trimSource(text: string): string {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SOURCE_CHARS
    ? `${collapsed.slice(0, MAX_SOURCE_CHARS)}…`
    : collapsed;
}

/**
 * 첫 사용자 메시지의 의도만으로 짧은 제목을 생성. 실패하거나 비면 null.
 *
 * 답변은 재료에 넣지 않는다 — 답변이 본론에서 벗어나면(도구 실패 복구 보고 등)
 * 제목도 같이 벗어나, 사용자가 시작한 주제와 안 맞는 제목이 붙는다 (실측:
 * "코드 제대로 작성되어 있는지 확인해봐" 세션에 "실행 실패 원인 점검").
 */
export async function generateSessionTitle(
  session: Session,
  { userText }: { userText: string },
): Promise<string | null> {
  const prompt = [
    '아래는 사용자가 대화를 시작하며 보낸 첫 메시지입니다.',
    '사용자가 어떤 주제로 무엇을 하려는지 파악해, 그 의도를 나타내는 제목을 지으세요.',
    '규칙: 첫 메시지와 같은 언어로, 8~20자 내외의 명사구 하나만.',
    '따옴표·마침표·마크다운 기호 없이 제목 텍스트만 출력하세요.',
    '',
    `첫 메시지: ${trimSource(userText)}`,
  ].join('\n');

  try {
    const raw = await runProviderText(session, {
      maxTokens: 60,
      messages: [{ content: prompt, role: 'user' }],
    });
    const title = sanitizeTitle(raw);
    if (!title) console.warn('[autoTitle] 모델이 빈 제목을 반환:', JSON.stringify(raw));
    return title || null;
  } catch (error) {
    // 제목은 장식이라 대화를 막지 않지만, 원인 추적은 가능해야 한다
    console.warn('[autoTitle] 생성 실패:', error);
    return null;
  }
}
