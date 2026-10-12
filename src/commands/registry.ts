import { checkinCommand } from './builtins/checkin.ts';
import { clearCommand } from './builtins/clear.ts';
import { compactCommand } from './builtins/compact.ts';
import { distillCommand } from './builtins/distill.ts';
import { exitCommand } from './builtins/exit.ts';
import { helpCommand } from './builtins/help.ts';
import { mcpCommand } from './builtins/mcp.ts';
import { modeCommand } from './builtins/mode.ts';
import { modelCommand } from './builtins/model.ts';
import { providerCommand } from './builtins/provider.ts';
import { recallCommand } from './builtins/recall.ts';
import { reflectCommand } from './builtins/reflect.ts';
import { rememberCommand } from './builtins/remember.ts';
import { resumeCommand } from './builtins/resume.ts';
import { sessionsCommand } from './builtins/sessions.ts';
import type { SlashCommand, SlashCommandEntry } from './types.ts';

export const COMMANDS: SlashCommand[] = [
  helpCommand,
  clearCommand,
  compactCommand,
  distillCommand,
  rememberCommand,
  recallCommand,
  checkinCommand,
  reflectCommand,
  sessionsCommand,
  resumeCommand,
  providerCommand,
  modelCommand,
  modeCommand,
  mcpCommand,
  exitCommand,
];

export const SLASH_COMMANDS = getCommandEntries();

export function getCommandEntries(commands = COMMANDS): SlashCommandEntry[] {
  return commands.flatMap(command => [
    {
      command: command.command,
      completion: command.completion,
      description: command.description,
    },
    ...(command.entries ?? []),
  ]);
}

export function formatSlashCommandHelp() {
  return [
    '사용 가능한 명령어',
    ...SLASH_COMMANDS.map(({ command, description }) =>
      `${command.padEnd(22, ' ')}${description}`,
    ),
  ].join('\n');
}
