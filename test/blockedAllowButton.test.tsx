/*
 * 막힌 명령을 그 자리에서 허용하는 버튼 회귀 테스트.
 *
 * 자동 모드의 분류기는 사용자가 대화로 "ㄱㄱ, 막지 마"라고 해도 차단 목록(배포,
 * 마이그레이션, 운영)을 풀지 않는다. 사용자가 이 명령을 실행하려면 권한 모드를 바꾸는
 * 수밖에 없었다. 막힌 도구 행에 "이 명령 허용"을 붙이고, 누르면 행 id만 메인 프로세스로
 * 보내는지 고정한다 (허용할 명령은 메인 프로세스가 기록해 둔 것을 쓴다).
 */
import { setupDom } from './domSetup.ts';

setupDom();

const { afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const React = (await import('react')).default;

const { Transcript } = await import('../app/renderer/src/components/Transcript.tsx');
import type { TranscriptRow } from '../app/renderer/src/types.ts';

function blocked(extra: Partial<TranscriptRow> = {}): TranscriptRow {
  return {
    content: 'MView 생성 DDL 실행',
    id: 'tool-call-1',
    input: { command: 'psql -f search_server_tables.sql' },
    name: 'run_command',
    result: '자동 모드에서 차단됨 — 분류기 판정: 운영 DB 구조 변경',
    role: 'tool',
    toolStatus: 'blocked',
    ...extra,
  };
}

function draw(rows: TranscriptRow[]) {
  render(
    <Transcript
      activeAgentId={null}
      approval={null}
      onOpenAgent={() => {}}
      onOpenSettings={() => {}}
      rows={rows}
      status={null}
      turnTokens={null}
    />,
  );
}

afterEach(() => cleanup());

describe('막힌 명령 허용 버튼', () => {
  test('자동 모드가 막은 행에는 접힌 채로도 버튼이 보이고, 누르면 행 id만 보낸다', () => {
    const allowBlockedCall = mock(() => {});
    (globalThis as any).window.newbie = { allowBlockedCall };

    draw([blocked({ allowable: true })]);
    fireEvent.click(screen.getByText('이 명령 허용'));

    expect(allowBlockedCall).toHaveBeenCalledTimes(1);
    expect(allowBlockedCall.mock.calls[0]).toEqual(['tool-call-1']);
    expect(screen.getByText('정확히 같은 명령만, 앱을 다시 켤 때까지 허용합니다')).toBeTruthy();
  });

  test('허용한 뒤에는 버튼 대신 허용했다는 안내가 남는다', () => {
    (globalThis as any).window.newbie = { allowBlockedCall: () => {} };

    draw([blocked({ allowable: true, allowed: true })]);

    expect(screen.queryByText('이 명령 허용')).toBeNull();
    expect(screen.getByText('허용했습니다. 같은 명령을 다시 실행하게 했습니다.')).toBeTruthy();
  });

  test('사용자가 승인 창에서 거절했거나 다시 연 대화의 막힌 행에는 버튼이 없다', () => {
    (globalThis as any).window.newbie = { allowBlockedCall: () => {} };

    draw([blocked()]);

    expect(screen.queryByText('이 명령 허용')).toBeNull();
  });
});
