import { errorMessage } from '../../utils/errors.ts';
import {
  appendCheckin,
  hasTodayCheckin,
  parseCheckinArgs,
} from '../../memory/checkin.ts';
import { appendToLog } from '../../memory/logger.ts';
import {
  getNextPendingQuestion,
  resolveQuestion,
} from '../../memory/questions.ts';
import type { SlashCommand, SlashCommandContext } from '../types.ts';

// 톤 규칙: 빠진 날을 지적하지 않고, 과한 축하도 하지
// 않는다. 조용히 기록하고 조용히 확인한다.
export const checkinCommand: SlashCommand = {
  command: '/checkin',
  description: '오늘 기분을 기록하고 Newbie의 확인 질문에 답합니다.',
  entries: [
    {
      command: '/checkin <1-10> [#태그] [메모]',
      completion: '/checkin ',
      description: '기분(1~10)을 기록합니다. #태그와 한 줄 메모는 선택.',
    },
    {
      command: '/checkin answer <답변>',
      completion: '/checkin answer ',
      description: '표시된 확인 질문에 답합니다.',
    },
    {
      command: '/checkin skip',
      completion: '/checkin skip',
      description: '표시된 확인 질문을 건너뜁니다.',
    },
  ],
  run(context, args) {
    const trimmed = args.trim();

    if (!trimmed) {
      showStatus(context);
      return;
    }

    if (trimmed === 'skip') {
      skipQuestion(context);
      return;
    }

    const answerMatch = trimmed.match(/^answer\s+([\s\S]+)$/);
    if (answerMatch) {
      answerQuestion(context, answerMatch[1].trim());
      return;
    }
    if (trimmed === 'answer') {
      context.appendRow({
        role: 'system',
        content: '답변 내용을 함께 적어주세요. 예: /checkin answer 맞아, 그 프로젝트는 끝났어',
      });
      return;
    }

    recordMood(context, trimmed);
  },
};

function showStatus(context: SlashCommandContext): void {
  const lines: string[] = [];

  lines.push(
    hasTodayCheckin()
      ? '오늘 기분은 이미 기록되어 있어요. 다시 기록하면 최신 값으로 봅니다.'
      : '오늘 기분: 아직 기록 전. /checkin <1-10> [#태그] [메모] 로 남길 수 있어요.',
  );

  const question = getNextPendingQuestion();
  if (question) {
    lines.push(
      '',
      `💭 확인하고 싶은 게 하나 있어요: ${question.text}`,
      '   답하기: /checkin answer <답변>  ·  넘기기: /checkin skip',
    );
  }

  context.appendRow({ role: 'system', content: lines.join('\n') });
}

function recordMood(context: SlashCommandContext, args: string): void {
  const parsed = parseCheckinArgs(args);
  if (!parsed) {
    context.appendRow({
      role: 'system',
      content: '기분은 1~10 사이 숫자로 적어주세요. 예: /checkin 7 #일 야근 끝',
    });
    return;
  }

  try {
    appendCheckin(parsed);
  } catch (error) {
    context.appendRow({ role: 'error', content: `기록 실패: ${errorMessage(error)}` });
    return;
  }

  // 당일 로그에도 남겨 다음 /distill이 기분 맥락을 함께 소화하게 한다
  const tagText = parsed.tags.length > 0 ? ` 태그: ${parsed.tags.join(', ')}` : '';
  const noteText = parsed.note ? ` — ${parsed.note}` : '';
  appendToLog('user', `[체크인] 기분 ${parsed.mood}/10${tagText}${noteText}`);

  context.appendRow({ role: 'system', content: `기록했어요. (기분 ${parsed.mood}/10)` });
}

function answerQuestion(context: SlashCommandContext, answer: string): void {
  const question = getNextPendingQuestion();
  if (!question) {
    context.appendRow({ role: 'system', content: '지금 답할 질문이 없어요.' });
    return;
  }

  // 큐 갱신이 성공한 뒤에만 로그로 환류한다. 반대 순서면 저장에 실패했을 때
  // 답변은 /distill이 소화하는데 질문은 다시 떠서 같은 답을 두 번 소화하게 된다.
  try {
    resolveQuestion(question.id, 'answered');
  } catch (error) {
    context.appendRow({ role: 'error', content: `저장 실패: ${errorMessage(error)}` });
    return;
  }

  // 답변을 당일 로그로 환류 — 다음 /distill이 topic 갱신·policy 반영에 사용한다
  appendToLog('user', `[확인 질문 답변] Q: ${question.text} A: ${answer}`);

  context.appendRow({ role: 'system', content: '고마워요, 기억해둘게요.' });
}

function skipQuestion(context: SlashCommandContext): void {
  const question = getNextPendingQuestion();
  if (!question) {
    context.appendRow({ role: 'system', content: '넘길 질문이 없어요.' });
    return;
  }

  try {
    resolveQuestion(question.id, 'skipped');
  } catch (error) {
    context.appendRow({ role: 'error', content: `저장 실패: ${errorMessage(error)}` });
    return;
  }

  context.appendRow({ role: 'system', content: '넘겼어요.' });
}
