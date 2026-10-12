import {
  formatSessionList,
  listSessions,
} from '../../session/storage.ts';
import type { SlashCommand } from '../types.ts';

export const sessionsCommand: SlashCommand = {
  command: '/sessions',
  description: '저장된 세션 목록을 봅니다.',
  run(context) {
    context.appendRow({
      role: 'system',
      content: formatSessionList(listSessions()),
      persist: false,
    });
  },
};
