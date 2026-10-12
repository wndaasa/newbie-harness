import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ScannedFile = {
  path: string;
  slug: string;
  frontmatter: Record<string, string>;
  body: string;
  mtimeMs: number;
};

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body: match[2].trim() };
}

// dir 내의 topic .md 파일 스캔 (MEMORY.md 제외)
export function scanTopicFiles(dir: string): ScannedFile[] {
  if (!existsSync(dir)) return [];

  const results: ScannedFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (entry.name === 'MEMORY.md') continue;

    const filePath = join(dir, entry.name);
    try {
      const content = readFileSync(filePath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);
      results.push({
        path: filePath,
        slug: entry.name.replace(/\.md$/, ''),
        frontmatter,
        body,
        mtimeMs: statSync(filePath).mtimeMs,
      });
    } catch {
      // 읽기 실패한 파일은 건너뜀
    }
  }
  return results;
}
