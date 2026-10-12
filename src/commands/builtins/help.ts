import type { SlashCommand } from '../types.ts';

export const helpCommand: SlashCommand = {
  command: '/help',
  description: '도움말을 봅니다.',
  run(context) {
    context.appendRow({ role: 'system', content: context.formatCommandHelp() });
  },
};
