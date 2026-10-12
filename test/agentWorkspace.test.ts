// 에이전트 작업 폴더 위치.
//
// 작업 폴더가 홈이면 <홈>/.newbie가 앱 데이터 폴더와 겹친다. 산출물이 세션 파일과
// 섞이지 않게 그때만 이름을 바꾼다.

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentTmpDir, agentWorkspaceDir, isInAgentTmp } from '../src/tools/agentWorkspace.ts';

const original = process.env.NEWBIE_HOME;
afterEach(() => {
  if (original === undefined) delete process.env.NEWBIE_HOME;
  else process.env.NEWBIE_HOME = original;
});

describe('에이전트 작업 폴더', () => {
  const project = join(tmpdir(), 'newbie-ws-project');

  test('작업 폴더 아래 .newbie를 쓴다', () => {
    process.env.NEWBIE_HOME = join(tmpdir(), 'newbie-ws-home', '.newbie');
    expect(agentWorkspaceDir(project)).toBe(join(project, '.newbie'));
    expect(agentTmpDir('abc', project)).toBe(join(project, '.newbie', 'tmp', 'abc'));
  });

  test('앱 데이터 폴더와 겹치면 .newbie-work를 쓴다', () => {
    process.env.NEWBIE_HOME = join(project, '.newbie');
    expect(agentWorkspaceDir(project)).toBe(join(project, '.newbie-work'));
  });

  test('임시 폴더 판정은 세션 폴더와 그 안만 포함한다', () => {
    process.env.NEWBIE_HOME = join(tmpdir(), 'newbie-ws-home', '.newbie');
    const ws = join(project, '.newbie');
    expect(isInAgentTmp(join(ws, 'tmp', 'abc', 'a.py'), project)).toBe(true);
    expect(isInAgentTmp(join(ws, 'tmp', 'abc'), project)).toBe(true);
    expect(isInAgentTmp(join(ws, 'tmp'), project)).toBe(false);
    expect(isInAgentTmp(join(ws, 'docs', 'a.md'), project)).toBe(false);
    expect(isInAgentTmp(join(ws, 'tmp', '..', 'docs', 'a.md'), project)).toBe(false);
    expect(isInAgentTmp(join(project, 'tmp_a.py'), project)).toBe(false);
  });
});
