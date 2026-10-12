import { runAgentLoop, stopSummary } from '../agent/loop.ts';
import { errorMessage } from '../utils/errors.ts';
import { buildSystemPrompt } from '../config.ts';
import { appendToLog } from '../memory/logger.ts';
import { recordSessionMessages } from '../session/storage.ts';
import type { Session } from '../session/types.ts';
import type { ProviderOutput } from '../providers/types.ts';
import type { createColors } from '../ui/colors.ts';

export async function runOnce({
  args,
  c,
  output,
  session,
}: {
  args: { once: string };
  c: ReturnType<typeof createColors>;
  output: ProviderOutput;
  session: Session;
}): Promise<void> {
  const text = args.once.trim();
  if (!text) return;

  session.messages.push({ role: 'user', content: text });
  output.write(c.dim('\n● '));

  try {
    const { stop, text: assistantText, toolTurns } = await runAgentLoop(session, {
      output,
      systemPrompt: await buildSystemPrompt(session),
    });
    // 답 없이 멈춘 턴은 빈 assistant 메시지를 남기지 않는다. 다음 요청에 빈 턴이 실려 나간다
    const answer = stop.cause === 'done' ? [{ role: 'assistant' as const, content: assistantText }] : [];
    session.messages.push(...toolTurns, ...answer);
    recordSessionMessages(session, [{ role: 'user', content: text }, ...toolTurns, ...answer]);
    if (stop.cause !== 'done') output.write(c.dim(`\n(${stopSummary(stop)})`));
    // mock 대화는 메모리 로그에도 남기지 않음 (/distill 정리 대상 아님)
    if (!session.mock) {
      appendToLog('user', text);
      appendToLog('assistant', assistantText);
    }
    output.write('\n');
  } catch (error) {
    session.messages.pop();
    output.write('\n');
    console.error(c.red(`오류: ${errorMessage(error)}`));
    process.exitCode = 1;
  }
}
