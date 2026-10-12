import { existsSync, readFileSync } from 'node:fs';
import { getInsightsBaseDir, getMemoryBaseDir, getMemoryIndexPath } from './paths.ts';
import { scanTopicFiles, type ScannedFile } from './scan.ts';

const MAX_INDEX_LINES = 200;
const MAX_TOPIC_FILES = 5;
const MAX_TOPIC_LINES = 100;

function isDisabled(noMemory?: boolean): boolean {
  if (noMemory) return true;
  const v = process.env.NEWBIE_NO_MEMORY ?? '';
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function readMemoryIndex(): string {
  const indexPath = getMemoryIndexPath();
  if (!existsSync(indexPath)) return '';

  try {
    const lines = readFileSync(indexPath, 'utf8').split(/\r?\n/);
    return lines.slice(0, MAX_INDEX_LINES).join('\n').trim();
  } catch {
    return '';
  }
}

// frontmatter의 updated(YYYY-MM-DD)를 우선 사용하고, 없으면 파일 mtime으로 대체.
// 최근에 갱신된 topic이 주입 슬롯(MAX_TOPIC_FILES)을 먼저 차지한다.
function topicRecency(topic: ScannedFile): number {
  const updated = Date.parse(topic.frontmatter.updated ?? '');
  return Number.isNaN(updated) ? topic.mtimeMs : updated;
}

function readTopicBodies(): string {
  const topics = scanTopicFiles(getMemoryBaseDir())
    .sort((a, b) => topicRecency(b) - topicRecency(a))
    .slice(0, MAX_TOPIC_FILES);
  if (topics.length === 0) return '';

  return topics
    .map(t => {
      const body = t.body.split(/\r?\n/).slice(0, MAX_TOPIC_LINES).join('\n').trim();
      if (!body) return '';
      // inferred(추론) 기억은 확정된 사실처럼 취급하지 않도록 표시해서 주입
      return t.frontmatter.source === 'confirmed'
        ? body
        : `[추정 — 확인 필요] ${body}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

// 세션 복귀 시 사용자에게 보여줄 짧은 recall 알림. 저장된 기억이 없으면 null.
export function getRecallSummary(noMemory?: boolean): string | null {
  if (isDisabled(noMemory)) return null;

  const indexCount = readMemoryIndex().split('\n').filter(Boolean).length;
  const count = indexCount || scanTopicFiles(getMemoryBaseDir()).length;
  if (count === 0) return null;

  return `🧠 이전 기억 ${count}개를 떠올렸어요.`;
}

export function loadMemoryContext(noMemory?: boolean): string {
  if (isDisabled(noMemory)) return '';

  const indexLines = readMemoryIndex();
  const topicBodies = readTopicBodies();

  if (!indexLines && !topicBodies) return '';

  const parts: string[] = ['# 기억하고 있는 것'];
  if (topicBodies) parts.push(topicBodies);
  if (indexLines) parts.push(`## 메모리 인덱스\n${indexLines}`);

  return parts.join('\n\n');
}

export type MemoryMatch = {
  slug: string;
  type: string;
  source: string;
  description: string;
  /** 키워드가 든 본문 줄. 많아도 앞의 몇 줄만 — 전문은 파일에 있다 */
  lines: string[];
};

const MAX_MATCH_LINES = 3;

// /recall <키워드> — 이름·설명·본문에 키워드가 든 topic과 insight를 최근 갱신순으로.
// 리콜 주입(readTopicBodies)과 달리 insight도 찾는다. 사용자가 직접 찾는 자리라
// 추정 기억도 보여야 하고, source 표시로 구분된다.
export function searchMemory(keyword: string): MemoryMatch[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return [];

  const files = [
    ...scanTopicFiles(getMemoryBaseDir()),
    ...scanTopicFiles(getInsightsBaseDir()),
  ].sort((a, b) => topicRecency(b) - topicRecency(a));

  const matches: MemoryMatch[] = [];
  for (const file of files) {
    const description = file.frontmatter.description ?? '';
    const lines = file.body
      .split(/\r?\n/)
      .filter(line => line.toLowerCase().includes(needle));
    const hit =
      file.slug.toLowerCase().includes(needle) ||
      description.toLowerCase().includes(needle) ||
      lines.length > 0;
    if (!hit) continue;

    matches.push({
      slug: file.slug,
      type: file.frontmatter.type ?? '',
      source: file.frontmatter.source ?? 'inferred',
      description,
      lines: lines.slice(0, MAX_MATCH_LINES),
    });
  }
  return matches;
}
