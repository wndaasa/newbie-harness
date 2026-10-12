import type { SlashCommand } from '../types.ts';

export const exitCommand: SlashCommand = {
  aliases: ['/quit', 'exit', 'quit'],
  command: '/exit',
  description: '종료합니다.',
  run(context) {
    context.exit();
  },
};
