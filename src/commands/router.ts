import { COMMANDS } from './registry.ts';
import type { SlashCommand, SlashCommandContext } from './types.ts';

export async function runSlashCommand(
  input: string,
  context: SlashCommandContext,
  commands: SlashCommand[] = COMMANDS,
): Promise<boolean> {
  const match = findSlashCommand(input, commands);
  if (!match) return false;

  await match.command.run(context, match.args, input);
  return true;
}

function findSlashCommand(input: string, commands: SlashCommand[]) {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const spaceIndex = trimmed.indexOf(' ');
  const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();
  const normalizedName = normalizeCommandName(commandName);

  const command = commands.find((candidate: SlashCommand) =>
    [candidate.command, ...(candidate.aliases ?? [])].some(alias =>
      normalizeCommandName(alias) === normalizedName,
    ),
  );

  if (!command) return undefined;
  return { args, command };
}

function normalizeCommandName(value: string): string {
  return value.trim().toLowerCase();
}
