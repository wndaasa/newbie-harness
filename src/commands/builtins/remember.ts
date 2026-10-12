import {
  isRememberType,
  REMEMBER_TYPES,
  rememberMemory,
  type RememberType,
} from '../../memory/remember.ts';
import { errorMessage } from '../../utils/errors.ts';
import type { SlashCommand } from '../types.ts';

const TYPE_LIST = REMEMBER_TYPES.join('·');
const USAGE = '기억할 내용을 함께 적어주세요. 예: /remember 답변은 짧게, 인사 없이';

export const rememberCommand: SlashCommand = {
  command: '/remember',
  description: '내용을 지금 바로 메모리에 저장합니다.',
  entries: [
    {
      command: '/remember <내용>',
      completion: '/remember ',
      description: '타입은 자동 분류. 같은 주제가 있으면 그 topic에 덧붙입니다.',
    },
    {
      command: '/remember --type <타입> <내용>',
      completion: '/remember --type ',
      description: `타입을 직접 지정합니다 (${TYPE_LIST}).`,
    },
  ],
  async run(context, args) {
    const parsed = parseArgs(args);
    if ('error' in parsed) {
      context.appendRow({ role: 'system', content: parsed.error });
      return;
    }

    context.appendRow({ role: 'system', content: '기억하는 중...' });
    try {
      const result = await rememberMemory(context.session, parsed.text, parsed.type);
      const where = result.appended ? '기존 topic에 덧붙였어요' : '새 topic으로 저장했어요';
      context.appendRow({
        role: 'system',
        content: `${where}. [${result.name}] (${result.type}) — ${result.description}`,
      });
    } catch (error) {
      context.appendRow({ role: 'error', content: `저장 실패: ${errorMessage(error)}` });
    }
  },
};

type ParsedArgs = { text: string; type?: RememberType } | { error: string };

function parseArgs(args: string): ParsedArgs {
  const trimmed = args.trim();
  const typeMatch = trimmed.match(/^--type(?:\s+(\S+))?\s*([\s\S]*)$/);
  if (!typeMatch) {
    return trimmed ? { text: trimmed } : { error: USAGE };
  }

  const [, type, rest] = typeMatch;
  if (!isRememberType(type)) {
    return {
      error: `타입은 ${TYPE_LIST} 중 하나로 적어주세요. 예: /remember --type feedback 답변은 짧게`,
    };
  }
  const text = rest.trim();
  return text ? { text, type } : { error: USAGE };
}
