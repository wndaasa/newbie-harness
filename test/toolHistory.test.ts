// 도구 이력 확장 회귀 테스트.
//
// 세션에는 화면용 필드(추론 요약)가 같이 저장되는데, 그대로 프로바이더에 나가면
// API가 모르는 필드로 거부한다. 확장 시점에 떼어내는지 고정한다.

import { describe, expect, test } from 'bun:test';
import { expandToolHistory, INTERJECTION_MARKER } from '../src/providers/toolHistory.ts';

describe('추론 요약은 프로바이더로 나가지 않는다', () => {
  const history = [
    { role: 'user' as const, content: '안녕' },
    { role: 'assistant' as const, content: '생각해 봤습니다', reasoning: '**Plan** ...' },
    {
      role: 'assistant' as const,
      content: '',
      reasoning: 'check file',
      toolCalls: [
        { id: 'c1', input: { path: 'a.ts' }, name: 'read_file', ok: true, result: '내용' },
      ],
    },
  ];

  test('openai 포맷', () => {
    const expanded = expandToolHistory(history, 'openai') as Record<string, unknown>[];
    expect(expanded.some(message => 'reasoning' in message)).toBe(false);
    // 본문과 도구 이력은 그대로다
    expect(expanded[1].content).toBe('생각해 봤습니다');
    expect(expanded.some(message => message.role === 'tool')).toBe(true);
  });

  test('anthropic 포맷', () => {
    const expanded = expandToolHistory(history, 'anthropic') as Record<string, unknown>[];
    expect(expanded.some(message => 'reasoning' in message)).toBe(false);
  });

  test('원본 이력은 건드리지 않는다', () => {
    expandToolHistory(history, 'openai');
    expect(history[1].reasoning).toBe('**Plan** ...');
  });
});

describe('작업 중 끼어든 메시지', () => {
  const history = [
    { at: '2026-08-21T03:00:00Z', content: '이거 해줘', readAt: '2026-08-21T03:00:00Z', role: 'user' as const },
    {
      at: '2026-08-21T03:00:05Z',
      content: '',
      role: 'assistant' as const,
      toolCalls: [{ id: 'c1', input: { path: 'a.ts' }, name: 'read_file', ok: true, result: 'x' }],
    },
    {
      at: '2026-08-21T03:00:07Z',
      content: '아 참고로 b.ts도 봐',
      interjected: true,
      readAt: '2026-08-21T03:00:09Z',
      role: 'user' as const,
    },
  ];

  test('모델에게는 표식이 붙고, 시각·표식 필드는 나가지 않는다', () => {
    const expanded = expandToolHistory(history, 'openai') as Record<string, unknown>[];
    const interjected = expanded.at(-1)!;
    expect(String(interjected.content)).toBe(`${INTERJECTION_MARKER}\n아 참고로 b.ts도 봐`);
    for (const message of expanded) {
      expect(message).not.toHaveProperty('at');
      expect(message).not.toHaveProperty('readAt');
      expect(message).not.toHaveProperty('interjected');
    }
    // 보통 메시지에는 표식이 없다
    expect(expanded[0].content).toBe('이거 해줘');
  });

  test('저장된 원문은 그대로다', () => {
    expandToolHistory(history, 'anthropic');
    expect(history[2].content).toBe('아 참고로 b.ts도 봐');
  });
});

describe('빈 assistant 메시지는 프로바이더로 나가지 않는다', () => {
  // 본문도 도구 호출도 없는 라운드는 진단용(사고 내용·종료 사유)으로만 세션에 남는다.
  // Anthropic은 빈 본문을 400으로 거부한다
  test('본문 없는 진단 메시지를 건너뛴다', () => {
    const history = [
      { role: 'user' as const, content: '해줘' },
      { role: 'assistant' as const, content: '', reasoning: '막혔다', stopReason: 'length' },
      { role: 'assistant' as const, content: '정리했습니다' },
    ];
    for (const provider of ['openai', 'anthropic']) {
      const expanded = expandToolHistory(history, provider) as Record<string, unknown>[];
      expect(expanded.length).toBe(2);
      expect(expanded.some(message => 'stopReason' in message)).toBe(false);
    }
  });
});
