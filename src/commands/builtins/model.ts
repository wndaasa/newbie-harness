import type { SlashCommand } from '../types.ts';

export const modelCommand: SlashCommand = {
  command: '/model',
  description: '현재 모델을 확인합니다.',
  entries: [
    {
      command: '/model <name>',
      completion: '/model ',
      description: '현재 세션의 모델을 변경합니다.',
    },
  ],
  run(context, args) {
    if (!args) {
      context.appendRow({
        role: 'system',
        content: `현재 모델: ${context.session.model}`,
      });
      return;
    }

    context.session.model = args;
    context.appendRow({
      role: 'system',
      content: `모델을 ${context.session.model}(으)로 변경했습니다.`,
    });
  },
};
