// run_command 승인 등급 회귀 테스트 — 파괴적 명령.
//
// 예전엔 작업 폴더 밖 삭제나 자격증명 삭제, git 강제 푸시 같은 파괴적 형태가
// confirm이라 권한 모드와 무관하게 사람 손을 강제로 거쳤다. 셸 명령 문자열
// 전체를 정규식으로 훑는 판정이라 코드 조각을 위험한 명령으로 오인하는 일이
// 반복돼(#e.key 사례), 이제는 이 형태들도 목록 밖 명령과 같은 classify로
// 낮췄다 — 자동 모드에서는 분류기가 판정하고, 다른 모드에서는 여전히 승인
// 창이 뜬다. 에이전트가 직접 만든 파일만 지우는 경우만 notice로 정적 통과한다.

import { describe, expect, test } from 'bun:test';
import '../src/tools/shell/runCommand.ts';
import { getToolApprovalDecision } from '../src/tools/registry.ts';

const severity = (command: string) =>
  getToolApprovalDecision('run_command', { command })?.severity ?? null;

describe('run_command 삭제 등급', () => {
  test('작업 폴더 안 재귀 삭제는 분류기로 간다', () => {
    expect(severity('rm -rf build')).toBe('classify');
    expect(severity('Remove-Item -Recurse -Force .\\dist')).toBe('classify');
  });

  test('작업 폴더 밖·자격증명 삭제도 이제는 분류기로 간다', () => {
    expect(severity('rm -rf ../other')).toBe('classify');
    expect(severity('rm -rf .env')).toBe('classify');
    expect(severity('rm -rf .git')).toBe('classify');
  });

  test('삭제가 아닌 파괴적 명령도 분류기로 간다', () => {
    expect(severity('git push -f origin main')).toBe('classify');
  });
});
