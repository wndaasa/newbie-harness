import { buildReflectionReport } from '../../memory/reflect.ts';
import { errorMessage } from '../../utils/errors.ts';
import type { SlashCommand } from '../types.ts';

export const reflectCommand: SlashCommand = {
  command: '/reflect',
  description: '쌓인 체크인 데이터로 기분 패턴을 되비춥니다.',
  run(context) {
    try {
      context.appendRow({ role: 'system', content: buildReflectionReport() });
    } catch (error) {
      // checkins/ 는 사용자가 직접 열어볼 수 있는 평문 파일이라 읽기가 실패할 수
      // 있다. catch 변수는 unknown이므로 error.message를 바로 읽지 않는다.
      context.appendRow({
        role: 'error',
        content: `리플렉션을 만들지 못했어요: ${errorMessage(error)}`,
      });
    }
  },
};
