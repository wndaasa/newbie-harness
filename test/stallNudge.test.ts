// 정체(stall) 재촉 메시지 회귀 테스트.
//
// 재촉은 user 역할로 들어가는 시스템 생성 메시지다. 모델이 사용자가 쓴 말로
// 착각해 재촉 자체에 대답해 버린 사고가 실제로 있었다 — 채팅 화면에 "이 채팅에는
// create_file 도구가 없습니다"류의 답이 그대로 노출됐다. 자동 알림 표식과
// 실패 도구 이름이 문구에 들어 있는지, 특정 도구 이름을 하드코딩하지 않는지 고정한다.

import { expect, test } from 'bun:test';
import { stallNudgeMessage } from '../src/agent/loop.ts';

test('사용자 메시지가 아니라는 자동 알림 표식으로 시작한다', () => {
  const message = stallNudgeMessage(['read_file']);
  expect(message.startsWith('[자동 알림')).toBe(true);
  expect(message).toContain('사용자가 보낸 메시지가 아닙니다');
  expect(message).toContain('답하거나');
});

test('실패한 도구 이름이 문구에 들어간다', () => {
  const message = stallNudgeMessage(['create_file', 'run_command']);
  expect(message).toContain('`create_file`');
  expect(message).toContain('`run_command`');
});

test('실패한 도구 외의 도구 이름을 하드코딩하지 않는다', () => {
  // 예전 문구가 create_file·edit_file을 예시로 박아 두는 바람에, 그 도구가 없는
  // 채팅 모드에서 모델이 "그 도구는 여기 없다"고 대답하는 오염이 일어났다
  const message = stallNudgeMessage(['web_search']);
  expect(message).not.toContain('create_file');
  expect(message).not.toContain('edit_file');
});
