import type { SlashCommand } from '../types.ts';
import { recordSessionClear } from '../../session/storage.ts';

export const clearCommand: SlashCommand = {
  command: '/clear',
  description: '현재 세션의 대화 기록을 비웁니다.',
  run(context) {
    context.session.messages = [];
    // 접힌 자리는 비운 이력을 가리키므로 함께 버린다 (파일의 clear 엔트리도 같은 효과)
    context.session.compaction = undefined;
    recordSessionClear(context.session);
    context.setRows([]);
    context.setNotice('현재 세션의 대화 기록을 비웠습니다.');
  },
};
