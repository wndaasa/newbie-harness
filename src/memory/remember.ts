import { existsSync, readFileSync } from 'node:fs';
import { runProviderText } from '../providers/index.ts';
import type { Session } from '../session/types.ts';
import { updateMemoryIndex, writeTopicFile } from './distill.ts';
import { getMemoryBaseDir, getMemoryIndexPath } from './paths.ts';
import { readMemoryIndex } from './recall.ts';
import { parseFrontmatter } from './scan.ts';
import { isValidSlug, resolveInside } from './slug.ts';

// /remember가 받는 타입. insight는 정의상 추론이라 사용자가 직접 넣을 수 없다
export const REMEMBER_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type RememberType = (typeof REMEMBER_TYPES)[number];

export function isRememberType(value: unknown): value is RememberType {
  return typeof value === 'string' && (REMEMBER_TYPES as readonly string[]).includes(value);
}

export type RememberResult = {
  name: string;
  type: RememberType;
  description: string;
  /** 같은 이름의 topic이 있어 본문 뒤에 덧붙였는지 */
  appended: boolean;
};

const MAX_DESCRIPTION_CHARS = 50;

const CLASSIFY_SYSTEM_PROMPT = `사용자가 직접 기억해 달라고 한 내용을 메모리 topic으로 분류하세요.

type:
- user: 사용자 역할, 목표, 지식 수준, 선호 방식
- feedback: 작업 방식 피드백 — 해야 할 것·하지 말아야 할 것
- project: 진행 중인 작업, 결정 사항, 데드라인
- reference: 외부 시스템 포인터 (대시보드, 이슈 트래커 등)

name:
- kebab-case 영문 slug. 기존 메모리 인덱스에 같은 주제가 있으면 그 slug를 그대로 쓰세요.

JSON only (다른 텍스트 없이):
{"name":"kebab-case-slug","description":"한 줄 설명 (50자 이내)","type":"user|feedback|project|reference"}`;

type Classified = {
  name?: string;
  description?: string;
  type?: RememberType;
};

// 값이 하나라도 이상하면 그 값만 대체한다 — 분류 실패가 저장 실패가 되면 안 된다
function parseClassified(output: string): Classified {
  const match = output.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const description =
      typeof parsed.description === 'string' ? parsed.description.trim() : '';
    return {
      name: isValidSlug(parsed.name) ? parsed.name : undefined,
      description: description || undefined,
      type: isRememberType(parsed.type) ? parsed.type : undefined,
    };
  } catch {
    return {};
  }
}

// LLM이 없어도(mock, 제공자 미설정) 저장은 되어야 한다. 이름은 시각으로, 설명은 본문 앞부분으로
function fallbackName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `note-${date}-${time}`;
}

function fallbackDescription(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DESCRIPTION_CHARS
    ? `${flat.slice(0, MAX_DESCRIPTION_CHARS)}…`
    : flat;
}

async function classify(session: Session, body: string): Promise<Classified> {
  const index = readMemoryIndex();
  const userMessage = [
    index ? `기존 메모리 인덱스:\n${index}\n\n` : '',
    `기억할 내용:\n${body}`,
  ].join('');

  try {
    const output = await runProviderText(session, {
      messages: [{ role: 'user', content: userMessage }],
      systemPrompt: CLASSIFY_SYSTEM_PROMPT,
      maxTokens: 256,
    });
    return parseClassified(output);
  } catch {
    // 제공자 오류는 분류만 포기한다. 사용자가 기억하라고 한 말을 잃는 쪽이 더 나쁘다
    return {};
  }
}

// 사용자가 직접 한 말이므로 source는 confirmed다. /distill의 병합 규칙(기존 confirmed는
// inferred로 낮추지 않음)이 이후 정제에서도 이 판단을 지킨다.
export async function rememberMemory(
  session: Session,
  text: string,
  typeOverride?: RememberType,
): Promise<RememberResult> {
  const body = text.trim();
  const classified = await classify(session, body);

  const name = classified.name ?? fallbackName();
  const type = typeOverride ?? classified.type ?? 'user';
  const description = classified.description ?? fallbackDescription(body);

  const baseDir = getMemoryBaseDir();
  const filePath = resolveInside(baseDir, `${name}.md`);
  let content = body;
  let appended = false;
  if (existsSync(filePath)) {
    // 같은 주제의 topic을 통째로 덮어쓰면 그동안 쌓인 내용이 사라진다. 뒤에 덧붙이고
    // 정리는 다음 /distill의 병합에 맡긴다
    const existing = parseFrontmatter(readFileSync(filePath, 'utf8')).body;
    if (existing) {
      content = `${existing}\n\n${body}`;
      appended = true;
    }
  }

  writeTopicFile({ name, description, type, body: content, source: 'confirmed' }, baseDir);
  updateMemoryIndex([{ name, description, link: `${name}.md` }], getMemoryIndexPath());

  return { name, type, description, appended };
}
