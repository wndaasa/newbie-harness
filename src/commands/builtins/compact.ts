import type { SlashCommand } from '../types.ts';

export const compactCommand: SlashCommand = {
  command: '/compact',
  description: '지금까지의 대화를 요약으로 접어 컨텍스트를 비웁니다.',
  run(context) {
    return context.compact();
  },
};
