/*
 * 대화 화면 묶기 회귀 테스트.
 *
 * 라운드가 끝날 때마다 assistant 행이 새로 열리므로(controller의
 * ensureAssistantRow), 도구를 여러 번 부르는 턴은 화면에 생각-조회-생각-조회로
 * 계단이 쌓였다. "목록 조회 5개" 한 줄로 접히는지 고정한다.
 */
import { setupDom } from './domSetup.ts';

setupDom();

const { afterEach, describe, expect, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const React = (await import('react')).default;

const { Transcript } = await import('../app/renderer/src/components/Transcript.tsx');
import type { TranscriptRow } from '../app/renderer/src/types.ts';

function think(id: string): TranscriptRow {
  return { content: '', id, reasoning: `생각 ${id}`, role: 'assistant' };
}
function tool(id: string, name = '목록 조회'): TranscriptRow {
  return { content: name, id, role: 'tool', toolStatus: 'done' };
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

describe('도구 묶기', () => {
  test('생각이 사이에 껴도 한 묶음으로 접는다', () => {
    draw([
      { content: '소스 코드 분석 좀 해줘', id: 'u1', role: 'user' },
      think('a1'),
      tool('t1'),
      think('a2'),
      tool('t2'),
      think('a3'),
      tool('t3'),
    ]);

    // 계단이 쌓이면 tool-group이 셋으로 갈린다
    expect(document.querySelectorAll('.tool-group').length).toBe(1);
    expect(screen.getByText('목록 조회 3개')).toBeTruthy();
  });

  test('도구가 먼저 오고 생각이 뒤따라도 한 묶음이다', () => {
    // 실제 화면은 조회-생각-조회-생각 순으로 나왔다
    draw([
      { content: '분석해줘', id: 'u1', role: 'user' },
      tool('t1'),
      think('a1'),
      tool('t2'),
      think('a2'),
      tool('t3'),
    ]);

    expect(document.querySelectorAll('.tool-group').length).toBe(1);
    expect(screen.getByText('목록 조회 3개')).toBeTruthy();
  });

  test('개행만 흘린 행은 본문으로 치지 않는다', () => {
    // 모델이 도구 앞에 개행 한 칸을 흘리면 content가 개행 문자 하나가 되어
    // truthy가 된다.
    // 화면에는 아무것도 안 보이는데 묶음만 끊겨 계단이 그대로 쌓였다
    draw([
      { content: '분석해줘', id: 'u1', role: 'user' },
      { content: '\n', id: 'a1', reasoning: '생각 1', role: 'assistant' },
      tool('t1'),
      { content: '  ', id: 'a2', reasoning: '생각 2', role: 'assistant' },
      tool('t2'),
    ]);

    expect(document.querySelectorAll('.tool-group').length).toBe(1);
    expect(screen.getByText('목록 조회 2개')).toBeTruthy();
  });

  test('묶음 안 생각 행은 도구 행과 같은 규격으로 그린다', () => {
    draw([
      { content: '분석해줘', id: 'u1', role: 'user' },
      think('a1'),
      tool('t1'),
    ]);

    // 묶음은 접힌 채로 시작하므로 펼쳐야 안쪽 행이 그려진다
    fireEvent.click(screen.getByText('목록 조회'));

    // in-group이 빠지면 margin-left: -8px가 살아나 도구 행보다 왼쪽으로
    // 튀어나가고, 번갈아 나올 때 지그재그가 된다
    expect(document.querySelectorAll('.reasoning.in-group').length).toBe(1);
    // 도구 행과 같은 묶음 안, 같은 부모에 나란히 있어야 규격이 맞는다
    expect(document.querySelectorAll('.tool-items > .reasoning.in-group').length).toBe(1);
  });

  test('묶음 밖 생각 행은 예전 규격을 유지한다', () => {
    draw([
      { content: '분석해줘', id: 'u1', role: 'user' },
      // 뒤에 도구가 없으므로 묶이지 않는다 — 본문 글자와 왼쪽을 맞춰야 한다
      { content: '답입니다', id: 'a1', reasoning: '생각', role: 'assistant' },
    ]);

    expect(document.querySelectorAll('.reasoning').length).toBe(1);
    expect(document.querySelectorAll('.reasoning.in-group').length).toBe(0);
  });

  test('마지막 답변의 생각은 묶이지 않는다', () => {
    draw([
      { content: '해줘', id: 'u1', role: 'user' },
      think('a1'),
      tool('t1'),
      // 본문이 아직 안 나온 답변 행 — 뒤에 도구가 없으므로 묶이면 안 된다.
      // 묶었다가 본문이 도착하면 답변이 묶음 밖으로 튀어나온다
      think('a2'),
    ]);

    expect(document.querySelectorAll('.tool-group').length).toBe(1);
    expect(screen.getByText('목록 조회')).toBeTruthy();
  });

  test('본문이 있는 답변은 묶음을 끊는다', () => {
    draw([
      { content: '해줘', id: 'u1', role: 'user' },
      tool('t1'),
      { content: '이건 이렇습니다', id: 'a1', reasoning: '생각', role: 'assistant' },
      tool('t2'),
    ]);

    // 모델이 중간에 말을 걸었으면 그건 별개의 묶음이다
    expect(document.querySelectorAll('.tool-group').length).toBe(2);
  });

  test('요약 줄은 도구만 센다', () => {
    draw([
      { content: '해줘', id: 'u1', role: 'user' },
      think('a1'),
      tool('t1'),
      think('a2'),
      tool('t2'),
    ]);

    // 생각 행까지 세면 "목록 조회 4개"가 된다
    expect(screen.getByText('목록 조회 2개')).toBeTruthy();
  });
});
