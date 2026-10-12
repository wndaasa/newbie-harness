// 워크트리 도구 회귀 테스트.
//
// 워크트리 이름은 .newbie/worktrees/<이름> 경로로 그대로 들어가므로, 경로 구분자나
// 상위 이동(..)이 새어 들어가면 지정 폴더 밖으로 워크트리가 생길 수 있다.
// 이름 검증이 그런 형태를 계속 거부하는지, 그리고 세 도구의 kind가 안전 수위대로
// 유지되는지(remove가 execute라 항상 승인을 거치는지) 고정한다.

import { describe, expect, test } from 'bun:test';
import { getToolKind } from '../src/tools/registry.ts';
import { validateBranchName, validateWorktreeName } from '../src/tools/worktree/worktree.ts';

describe('워크트리 이름 검증', () => {
  const valid = ['feature-login', 'fix_crash', 'v1.2', 'a', 'A1', 'task-42'];
  for (const name of valid) {
    test(`허용: ${name}`, () => {
      expect(validateWorktreeName(name)).toBe(name);
    });
  }

  const invalid = [
    '',
    ' ',
    '-lead-hyphen',
    'trailing-',
    '.hidden',
    'a/b', // 경로 구분자
    'a\\b',
    '../escape', // 상위 이동
    'a b', // 공백
    'name!', // 특수문자
  ];
  for (const name of invalid) {
    test(`거부: ${JSON.stringify(name)}`, () => {
      expect(() => validateWorktreeName(name)).toThrow();
    });
  }
});

describe('브랜치 이름 검증', () => {
  // 폴더명보다 느슨하게 슬래시는 허용하되 명백히 위험한 형태만 거부
  test('슬래시 포함 브랜치는 허용', () => {
    expect(validateBranchName('feature/login')).toBe('feature/login');
  });

  for (const branch of ['', '-x', 'a b', 'a..b']) {
    test(`거부: ${JSON.stringify(branch)}`, () => {
      expect(() => validateBranchName(branch)).toThrow();
    });
  }
});

describe('워크트리 도구 kind', () => {
  // kind 하나로 안전 수위가 정해진다: 조회는 자동 허용, 제거는 항상 승인
  test('worktree_list는 read', () => {
    expect(getToolKind('worktree_list')).toBe('read');
  });

  test('worktree_add는 write', () => {
    expect(getToolKind('worktree_add')).toBe('write');
  });

  test('worktree_remove는 execute (되돌리기 어려워 항상 승인)', () => {
    expect(getToolKind('worktree_remove')).toBe('execute');
  });
});
