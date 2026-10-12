import { errorRow } from '../../providers/errorInfo.ts';
import { distillLogs } from '../../memory/distill.ts';
import type { SlashCommand } from '../types.ts';

export const distillCommand: SlashCommand = {
  command: '/distill',
  description: '최근 대화 로그를 분석해 메모리로 정제합니다.',
  entries: [
    {
      command: '/distill --days <N>',
      completion: '/distill --days ',
      description: '처리할 최근 일수를 지정합니다. 기본값 7.',
    },
  ],
  async run(context, args) {
    const days = parseDays(args) ?? 7;
    context.appendRow({
      role: 'system',
      content: `로그 분석 중... (최근 ${days}일)`,
    });

    try {
      const result = await distillLogs(context.session, days);
      context.appendRow({ role: 'system', content: result.summary });
    } catch (error) {
      context.appendRow(errorRow(error));
    }
  },
};

function parseDays(args: string): number | null {
  if (!args) return null;
  const flagMatch = args.match(/--days\s+(\d+)/);
  if (flagMatch) return Number(flagMatch[1]);
  const bareMatch = args.trim().match(/^(\d+)$/);
  if (bareMatch) return Number(bareMatch[1]);
  return null;
}
