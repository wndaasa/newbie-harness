import type { PermissionMode } from '../../agent/permissions.ts';
import {
  normalizePermissionMode,
  PERMISSION_MODE_LABELS,
} from '../../agent/permissions.ts';
import type { SlashCommand } from '../types.ts';

export const modeCommand: SlashCommand = {
  command: '/mode',
  completion: '/mode ',
  description: '권한 모드를 확인하거나 변경합니다 (좌하단 칩에서도 선택).',
  entries: [
    {
      command: '/mode accept',
      completion: '/mode accept',
      description: '편집 수락 — 파일 읽기·쓰기 자동 허용, 셸 실행만 승인 요청',
    },
    {
      command: '/mode ask',
      completion: '/mode ask',
      description: '권한 요청 — 파일 쓰기와 셸 실행 모두 승인 요청',
    },
    {
      command: '/mode auto',
      completion: '/mode auto',
      description: '자동 — 되돌릴 수 없는 작업은 묻지 않고 차단 (기본값)',
    },
  ],
  run(context, args) {
    const value = args.trim();

    if (!value) {
      const current = PERMISSION_MODE_LABELS[context.session.permissionMode as PermissionMode] ?? '알 수 없음';
      context.appendRow({
        role: 'system',
        content: [
          `현재 권한 모드: ${current}`,
          '변경: /mode accept | ask | auto (좌하단 칩에서도 선택)',
        ].join('\n'),
      });
      return;
    }

    const mode = normalizePermissionMode(value);
    if (!mode) {
      context.appendRow({
        role: 'error',
        content: `알 수 없는 모드: ${value} (accept, ask, auto 중 하나)`,
      });
      return;
    }

    context.setPermissionMode(mode);
    context.appendRow({
      role: 'system',
      content: `권한 모드를 변경했습니다: ${PERMISSION_MODE_LABELS[mode]}`,
    });
  },
};
