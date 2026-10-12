import { readMemoryIndex, searchMemory } from '../../memory/recall.ts';
import type { SlashCommand } from '../types.ts';

export const recallCommand: SlashCommand = {
  command: '/recall',
  description: '저장된 기억 목록을 보거나 키워드로 찾습니다.',
  entries: [
    {
      command: '/recall <키워드>',
      completion: '/recall ',
      description: '이름·설명·본문에 키워드가 든 기억을 찾습니다.',
    },
  ],
  run(context, args) {
    const keyword = args.trim();
    context.appendRow({
      role: 'system',
      content: keyword ? formatSearch(keyword) : formatIndex(),
    });
  },
};

function formatIndex(): string {
  const lines = readMemoryIndex().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return '저장된 기억이 없어요. /remember <내용> 으로 남기거나, 대화가 쌓이면 /distill 이 정리해요.';
  }
  return [`기억 ${lines.length}개`, ...lines, '', '자세히 보려면 /recall <키워드>'].join('\n');
}

function formatSearch(keyword: string): string {
  const matches = searchMemory(keyword);
  if (matches.length === 0) return `'${keyword}' 관련 기억이 없어요.`;

  const lines = [`'${keyword}' 관련 기억 ${matches.length}개`];
  for (const match of matches) {
    const source = match.source === 'confirmed' ? '확인됨' : '추정';
    lines.push(`- [${match.slug}] (${match.type} · ${source}) — ${match.description}`);
    for (const line of match.lines) lines.push(`    ${line}`);
  }
  return lines.join('\n');
}
