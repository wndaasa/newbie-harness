// 도구 실행 행의 제목·대상 표시 회귀 테스트.
//
// 제목은 실행 중 UI(controller)와 세션 복원(storage)이 같은 함수를 쓴다.
// 여기서 어긋나면 같은 대화가 실행 중과 다시 열었을 때 다르게 보인다.

import { describe, expect, test } from 'bun:test';
import { toolRowTarget, toolRowTitle } from '../src/ui/toolLabels.ts';

describe('도구 행 제목', () => {
  test('모델이 붙인 description이 제목이 된다', () => {
    expect(
      toolRowTitle({ name: 'run_command', input: { command: 'bun --version', description: 'bun 설치 여부 확인' } }),
    ).toBe('bun 설치 여부 확인');
  });

  test('description이 없으면 도구 라벨로 돌아간다', () => {
    expect(toolRowTitle({ name: 'run_command', input: { command: 'bun test' } })).toBe('명령 실행');
    expect(toolRowTitle({ name: 'start_process', input: { command: 'bun run dev' } })).toBe('백그라운드 실행');
    expect(toolRowTitle({ name: 'read_process', input: { id: 'abc' } })).toBe('프로세스 출력');
  });

  test('여러 줄·긴 설명은 한 줄로 줄이고 자른다', () => {
    const long = `첫 줄\n  둘째 줄 ${'가'.repeat(100)}`;
    const title = toolRowTitle({ name: 'run_command', input: { command: 'x', description: long } });
    expect(title).not.toContain('\n');
    expect(title.startsWith('첫 줄 둘째 줄')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
  });

  test('빈 description은 없는 것으로 본다', () => {
    expect(toolRowTitle({ name: 'run_command', input: { command: 'x', description: '   ' } })).toBe('명령 실행');
  });
});

describe('도구 행 대상', () => {
  test('백그라운드 명령은 명령, 프로세스 도구는 id를 보여준다', () => {
    expect(toolRowTarget({ name: 'start_process', input: { command: 'bun run dev' } })).toBe('bun run dev');
    expect(toolRowTarget({ name: 'read_process', input: { id: '09d2a197' } })).toBe('09d2a197');
    expect(toolRowTarget({ name: 'stop_process', input: { id: '09d2a197' } })).toBe('09d2a197');
  });

  test('화면 캡처는 주소 또는 파일 경로', () => {
    expect(toolRowTarget({ name: 'capture_page', input: { url: 'http://localhost:5173' } })).toBe(
      'http://localhost:5173',
    );
    expect(toolRowTarget({ name: 'capture_page', input: { path: 'demo/index.html' } })).toBe('demo/index.html');
  });
});
