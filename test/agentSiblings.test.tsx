/*
 * 보조 에이전트 패널의 형제 묶기 회귀 테스트.
 *
 * 한 응답에서 spawn_agent를 여러 번 부르면 패널에는 그중 하나만 보인다. 몇 개
 * 중 몇 번째인지 알 수 있어야 하는데, 형제를 너무 넓게 잡으면 앞 턴의 조사까지
 * 세어 이번 턴에 몇 개를 맡겼는지가 흐려진다. 턴 경계와 부모 구분을 고정한다.
 */
import { setupDom } from './domSetup.ts';

setupDom();

const { describe, expect, test } = await import('bun:test');

const { agentSiblings } = await import('../app/renderer/src/components/Transcript.tsx');
import type { TranscriptRow } from '../app/renderer/src/types.ts';

function user(id: string): TranscriptRow {
  return { content: `요청 ${id}`, id, role: 'user' };
}
function agent(id: string, parentId?: string): TranscriptRow {
  return {
    content: `조사 ${id}`,
    id,
    name: 'spawn_agent',
    role: 'tool',
    toolStatus: 'done',
    ...(parentId ? { parentId } : {}),
  };
}
function tool(id: string): TranscriptRow {
  return { content: '파일 읽기', id, name: 'read_file', role: 'tool', toolStatus: 'done' };
}

function ids(rows: TranscriptRow[]): string[] {
  return rows.map(row => row.id);
}

describe('agentSiblings', () => {
  test('같은 턴에 함께 뜬 에이전트를 화면 순서대로 모은다', () => {
    const rows = [user('u1'), agent('a1'), agent('a2')];
    expect(ids(agentSiblings(rows, rows[1]))).toEqual(['a1', 'a2']);
    expect(ids(agentSiblings(rows, rows[2]))).toEqual(['a1', 'a2']);
  });

  test('사이에 낀 다른 도구는 형제로 세지 않는다', () => {
    const rows = [user('u1'), agent('a1'), tool('t1'), agent('a2')];
    expect(ids(agentSiblings(rows, rows[1]))).toEqual(['a1', 'a2']);
  });

  test('앞 턴의 에이전트는 형제가 아니다', () => {
    const rows = [user('u1'), agent('a1'), user('u2'), agent('a2'), agent('a3')];
    expect(ids(agentSiblings(rows, rows[3]))).toEqual(['a2', 'a3']);
    expect(ids(agentSiblings(rows, rows[1]))).toEqual(['a1']);
  });

  test('부모가 다르면 형제가 아니다 — 자식이 띄운 에이전트는 따로 센다', () => {
    const rows = [user('u1'), agent('a1'), agent('a2'), agent('c1', 'a1')];
    expect(ids(agentSiblings(rows, rows[1]))).toEqual(['a1', 'a2']);
    expect(ids(agentSiblings(rows, rows[3]))).toEqual(['c1']);
  });

  test('혼자 뜬 에이전트는 자기 자신만 돌려준다', () => {
    const rows = [user('u1'), agent('a1')];
    expect(ids(agentSiblings(rows, rows[1]))).toEqual(['a1']);
  });

  test('행 목록에서 사라진 에이전트도 빈 배열이 아니라 자기 자신을 돌려준다', () => {
    const rows = [user('u1'), agent('a1')];
    expect(ids(agentSiblings(rows, agent('gone')))).toEqual(['gone']);
  });
});
