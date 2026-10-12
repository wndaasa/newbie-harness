import type { PermissionMode } from '../agent/permissions.ts';
import type { SessionRow } from '../session/storage.ts';
import type { Session, SessionMode } from '../session/types.ts';

export type SlashCommandEntry = {
  command: string;
  completion?: string;
  description: string;
};

export type SlashCommandContext = {
  appendRow(row: SessionRow & { persist?: boolean }): void;
  /** 이 대화의 이력을 지금 접는다 (/compact). 화면의 "압축 중..." 줄까지 컨트롤러가 맡는다 */
  compact(): Promise<void>;
  exit(): void;
  formatCommandHelp(): string;
  session: Session;
  setMode(value: SessionMode): void;
  setNotice(value: string): void;
  setPermissionMode(value: PermissionMode): void;
  setRows(value: SessionRow[]): void;
};

export type SlashCommand = SlashCommandEntry & {
  aliases?: string[];
  entries?: SlashCommandEntry[];
  run(context: SlashCommandContext, args: string, input: string): Promise<void> | void;
};
