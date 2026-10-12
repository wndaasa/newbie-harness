/*
 * 답변 속 코드 블록의 복사 버튼과, 메시지를 보내면 맨 아래로 내려가는 스크롤 회귀 테스트.
 *
 * 답변에 담긴 명령을 옮기려면 끌어서 골라야 했고, 위로 올려 읽다가 메시지를 보내면
 * 화면이 그대로 있어 직접 내려야 했다.
 */
import { setupDom } from './domSetup.ts';

setupDom();

const { afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const React = (await import('react')).default;

const { Markdown, CodeBlock } = await import('../app/renderer/src/components/Markdown.tsx');
const { Transcript } = await import('../app/renderer/src/components/Transcript.tsx');
import type { TranscriptRow } from '../app/renderer/src/types.ts';

afterEach(() => cleanup());

describe('코드 블록 복사', () => {
  test('답변 속 코드 블록 우상단의 버튼을 누르면 코드 원문이 복사된다', async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const command = "psql -h localhost -p 5432 -f 'C:\\sql\\search_server_tables.sql'";

    render(<Markdown content={`다시 실행해 주세요.\n\n\`\`\`powershell\n${command}\n\`\`\``} />);
    const button = screen.getByLabelText('코드 복사');
    fireEvent.click(button);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]).toEqual([command]);
    // 눌렀다는 표시로 잠깐 체크 아이콘이 된다
    await waitFor(() => expect(button.className).toContain('copied'));
    // 가로로 스크롤되는 코드 상자 밖(감싼 상자)에 있어 긴 줄을 밀어도 제자리다
    expect(button.parentElement?.className).toBe('code-block-wrap');
  });

  test('인라인 코드와 도구 상세의 코드 블록에는 붙이지 않는다', () => {
    render(
      <>
        <Markdown content="`npm test`를 실행하세요." />
        <CodeBlock code="const a = 1;" language="typescript" />
      </>,
    );

    expect(screen.queryByLabelText('코드 복사')).toBeNull();
  });
});

describe('메시지를 보내면 맨 아래로', () => {
  function user(id: string): TranscriptRow {
    return { content: `질문 ${id}`, id, role: 'user' };
  }
  function answer(id: string): TranscriptRow {
    return { content: `답변 ${id}`, id, role: 'assistant' };
  }
  function draw(rows: TranscriptRow[]) {
    return (
      <Transcript
        activeAgentId={null}
        approval={null}
        onOpenAgent={() => {}}
        onOpenSettings={() => {}}
        rows={rows}
        status={null}
        turnTokens={null}
      />
    );
  }

  test('위로 올려 읽던 중에 사용자 메시지가 붙으면 맨 아래로 내려간다', () => {
    (globalThis as any).window.newbie = {};
    const rows = [user('u1'), answer('a1')];
    const view = render(draw(rows));
    const box = view.container.querySelector('.transcript') as HTMLDivElement;
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 5_000 });

    // 사용자가 휠을 올려 맨 아래 고정이 풀린 상태
    fireEvent.wheel(box, { deltaY: -120 });
    box.scrollTop = 0;

    // 답변이 길어지는 것만으로는 내려가지 않는다 (읽는 중이다)
    view.rerender(draw([...rows, answer('a2')]));
    expect(box.scrollTop).toBe(0);

    // 사용자가 메시지를 보내면 맨 아래로 간다
    view.rerender(draw([...rows, answer('a2'), user('u2')]));
    expect(box.scrollTop).toBe(5_000);
  });
});
