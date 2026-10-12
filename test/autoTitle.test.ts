// 세션 제목 자동 생성 회귀 테스트.
//
// 제목 생성은 첫 사용자 턴 직후에만 발동해야 하고(재개 세션의 이름을 덮으면 안
// 된다), 모델 출력의 따옴표·서식·군말은 제목에서 벗겨야 한다. 폴백(firstPrompt)의
// 마크다운 서식 제거도 함께 고정한다.

import { describe, expect, test } from 'bun:test';
import { sanitizeTitle, shouldAutoTitleSession } from '../src/session/autoTitle.ts';
import { stripMarkdownSyntax } from '../src/session/storage.ts';

function session(userMessages: number, mock = false) {
  const messages = [];
  for (let i = 0; i < userMessages; i++) {
    messages.push({ role: 'user', content: `질문 ${i}` });
    messages.push({ role: 'assistant', content: `답변 ${i}` });
  }
  return { messages, mock } as any;
}

describe('발동 조건', () => {
  test('첫 사용자 턴 직후에만 발동한다', () => {
    expect(shouldAutoTitleSession(session(1))).toBe(true);
    expect(shouldAutoTitleSession(session(2))).toBe(false); // 재개·후속 턴
    expect(shouldAutoTitleSession(session(0))).toBe(false);
  });

  test('mock 세션에는 발동하지 않는다', () => {
    expect(shouldAutoTitleSession(session(1, true))).toBe(false);
  });
});

describe('제목 정리', () => {
  test('따옴표·마침표·서식 기호를 벗긴다', () => {
    expect(sanitizeTitle('"AUC 개념 정리"')).toBe('AUC 개념 정리');
    expect(sanitizeTitle('**멀티홉 검색 설계**.')).toBe('멀티홉 검색 설계');
  });

  test('식별자의 언더스코어는 보존한다', () => {
    expect(sanitizeTitle('run_experiment.py 실험 코드 검토')).toBe(
      'run_experiment.py 실험 코드 검토',
    );
  });

  test('여러 줄이면 첫 줄만 쓴다', () => {
    expect(sanitizeTitle('제목: 수식 렌더링 버그\n\n부연 설명입니다.')).toBe(
      '수식 렌더링 버그',
    );
  });

  test('40자로 자른다', () => {
    expect(sanitizeTitle('가'.repeat(80)).length).toBeLessThanOrEqual(40);
  });

  test('빈 출력이면 빈 문자열', () => {
    expect(sanitizeTitle('')).toBe('');
    expect(sanitizeTitle('\n\n')).toBe('');
  });
});

describe('firstPrompt 폴백의 마크다운 서식 제거', () => {
  test('헤딩·강조·목록 기호를 벗긴다', () => {
    expect(stripMarkdownSyntax('# 제목 ## 1. 용어 - **AUC**: 탐지기의 종합 성능')).toBe(
      '제목 1. 용어 AUC: 탐지기의 종합 성능',
    );
  });

  test('단어 끝의 #은 보존한다 (C# 등)', () => {
    expect(stripMarkdownSyntax('C# 코드 리뷰해줘')).toBe('C# 코드 리뷰해줘');
  });

  test('코드 펜스 마커와 백틱을 지운다', () => {
    expect(stripMarkdownSyntax('```ts\nconst a = 1;\n``` 설명해줘')).toBe(
      'const a = 1; 설명해줘',
    );
    expect(stripMarkdownSyntax('`edit_file` 버그')).toBe('edit_file 버그');
  });

  test('서식 없는 문장은 그대로', () => {
    expect(stripMarkdownSyntax('사이드바 기본 크기 늘려줘')).toBe(
      '사이드바 기본 크기 늘려줘',
    );
  });
});
