import { describe, expect, test } from 'bun:test';
import { isProseResult } from '../app/renderer/src/toolResultKind.ts';

describe('isProseResult', () => {
  test('한국어 안내 한 줄은 문장이다', () => {
    expect(isProseResult('화면을 찍었습니다: shot.png (제목: Focusly)')).toBe(true);
  });

  test('명령이 섞인 안내도 문장이다', () => {
    // 세미콜론·괄호를 코드 신호로 쓰면 이런 결과가 고정폭으로 새어 나간다
    const text = '백그라운드로 실행했습니다 (id: ab11dec9)\n명령: cd bun-react-site; bun run dev';
    expect(isProseResult(text)).toBe(true);
  });

  test('경로가 든 안내도 문장이다', () => {
    expect(isProseResult('파일을 생성했습니다: C:\\Users\\me\\demo\\main.js')).toBe(true);
  });

  test('칸 맞춘 표 출력은 코드다', () => {
    // 한글 머리말이 붙어 있어도 표는 표다 (한글이 없으면 앞 조건에서 걸러져
    // 이 규칙을 검증하지 못하므로, 일부러 한글을 넣는다)
    const table = '포트 목록입니다\nLocalAddress LocalPort OwningProcess\n::           3000      3348';
    expect(isProseResult(table)).toBe(false);
  });

  test('들여쓰기된 줄이 있으면 코드다', () => {
    expect(isProseResult('결과입니다\n  const a = 1;')).toBe(false);
  });

  test('JSON으로 시작하면 코드다', () => {
    expect(isProseResult('{\n"결과": "성공"\n}')).toBe(false);
  });

  test('탭이 있으면 코드다', () => {
    expect(isProseResult('목록\n항목\t값')).toBe(false);
  });

  test('한글이 없으면 건드리지 않는다', () => {
    expect(isProseResult('Wrote 3 files.')).toBe(false);
  });

  test('길면 출력물로 본다', () => {
    expect(isProseResult(`오류가 났습니다. ${'가'.repeat(700)}`)).toBe(false);
  });

  test('줄이 많으면 출력물로 본다', () => {
    expect(isProseResult(Array.from({ length: 9 }, (_, i) => `${i}번째 줄`).join('\n'))).toBe(false);
  });

  test('빈 결과는 문장이 아니다', () => {
    expect(isProseResult('   \n  ')).toBe(false);
  });
});
