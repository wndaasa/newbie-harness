import { errorRow } from '../../providers/errorInfo.ts';
import {
  assertProviderReady,
  getDefaultModel,
  normalizeProvider,
} from '../../config.ts';
import type { SlashCommand } from '../types.ts';

export const providerCommand: SlashCommand = {
  command: '/provider',
  description: '현재 제공자를 확인합니다.',
  entries: [
    {
      command: '/provider <name>',
      completion: '/provider ',
      description: '제공자를 변경하고 기본 모델로 바꿉니다.',
    },
  ],
  run(context, args) {
    if (!args) {
      context.appendRow({
        role: 'system',
        content: `현재 제공자: ${context.session.provider}`,
      });
      return;
    }

    const previousProvider = context.session.provider;
    const previousModel = context.session.model;
    try {
      context.session.provider = normalizeProvider(args);
      context.session.model = getDefaultModel(context.session.provider);
      assertProviderReady(context.session);
      context.appendRow({
        role: 'system',
        content: `제공자를 ${context.session.provider}(으)로 변경했습니다. 현재 모델은 ${context.session.model}입니다.`,
      });
    } catch (error) {
      context.session.provider = previousProvider;
      context.session.model = previousModel;
      context.appendRow(errorRow(error));
    }
  },
};
