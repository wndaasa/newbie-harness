import { errorRow } from '../../providers/errorInfo.ts';
import {
  applyLoadedSession,
  formatSessionList,
  listSessions,
  loadLatestSession,
  loadSessionById,
} from '../../session/storage.ts';
import type { SlashCommand } from '../types.ts';

export const resumeCommand: SlashCommand = {
  aliases: ['/continue'],
  command: '/resume',
  description: '저장된 세션을 불러옵니다.',
  entries: [
    {
      command: '/resume <session-id>',
      completion: '/resume ',
      description: '지정한 세션을 불러옵니다.',
    },
    {
      command: '/continue',
      description: '가장 최근 세션을 이어서 시작합니다.',
    },
  ],
  run(context, args, input) {
    const isContinue = input.trim().toLowerCase().startsWith('/continue');

    if (!isContinue && !args) {
      context.appendRow({
        role: 'system',
        content: formatSessionList(listSessions()),
        persist: false,
      });
      return;
    }

    try {
      const loaded = isContinue ? loadLatestSession() : loadSessionById(args);
      applyLoadedSession(context.session, loaded);
      context.session.mode = 'agent';
      context.setMode('agent');
      context.setRows(loaded.rows);
      context.appendRow({
        role: 'system',
        content: `세션을 불러왔습니다: ${loaded.sessionId}`,
        persist: false,
      });
    } catch (error) {
      context.appendRow({ ...errorRow(error), persist: false });
    }
  },
};
