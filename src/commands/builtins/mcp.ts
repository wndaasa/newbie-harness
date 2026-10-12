import {
  connectMcpServers,
  formatMcpStatus,
  getMcpConfigPath,
  reauthMcpServer,
  reconnectMcpServer,
} from '../../mcp/index.ts';
import { errorMessage } from '../../utils/errors.ts';
import type { SlashCommand, SlashCommandContext } from '../types.ts';

const USAGE = '사용법: /mcp, /mcp reconnect [서버 이름], /mcp auth <서버 이름>';

export const mcpCommand: SlashCommand = {
  command: '/mcp',
  completion: '/mcp ',
  description: 'MCP 서버 연결 상태를 봅니다.',
  entries: [
    { command: '/mcp reconnect', description: 'MCP 서버를 다시 연결합니다.' },
    { command: '/mcp auth', description: 'MCP 서버 인증을 다시 받습니다.' },
  ],
  async run(context, args) {
    const [action = '', name = ''] = args.trim().split(/\s+/);

    try {
      if (action === 'reconnect') {
        if (name && !(await reconnectMcpServer(name))) return notifyUnknown(context, name);
        if (!name) await connectMcpServers();
      } else if (action === 'auth') {
        if (!name) return notify(context, USAGE);
        // 승인은 브라우저에서 이뤄지고, 그동안 이 호출은 코드가 돌아올 때까지 기다린다
        if (!(await reauthMcpServer(name))) return notifyUnknown(context, name);
      } else if (action) {
        return notify(context, USAGE);
      }
    } catch (error) {
      context.appendRow({
        content: `MCP 연결 실패: ${errorMessage(error)}`,
        persist: false,
        role: 'error',
      });
      return;
    }

    notify(context, formatMcpStatus());
  },
};

function notify(context: SlashCommandContext, content: string): void {
  context.appendRow({ content, persist: false, role: 'system' });
}

function notifyUnknown(context: SlashCommandContext, name: string): void {
  notify(context, `설정에 없는 서버입니다: ${name} (${getMcpConfigPath()})`);
}
