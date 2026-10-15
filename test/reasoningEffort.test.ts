// 제공자별 추론 강도 회귀 테스트.
//
// 추론 강도는 OpenAI와 vLLM 요청에만 실리고 있었다. Anthropic 요청에는 빠져 있어
// Haiku 5.5가 모델 기본값으로 생각한 뒤, 생각에서 쓴 요약을 이미 보여 준 것처럼
// "앞서 드린 요약이 유효합니다"로만 답한 사례가 있었다. 강도는 세션에 하나만
// 저장되므로 제공자를 바꾸면 그 제공자가 받지 않는 값이 남을 수 있다.

import { describe, expect, test } from 'bun:test';
import { anthropicEffort, supportsAnthropicEffort } from '../src/providers/anthropic.ts';
import { ollamaThink } from '../src/providers/ollama.ts';
import { effortForProvider } from '../src/providers/openaiResponses.ts';

describe('effortForProvider', () => {
  test('Anthropic은 "끔"을 받지 않아 가장 낮은 단계로 보낸다', () => {
    expect(effortForProvider('anthropic', 'none')).toBe('low');
    expect(effortForProvider('anthropic', 'minimal')).toBe('low');
    expect(effortForProvider('anthropic', 'xhigh')).toBe('high');
    expect(effortForProvider('anthropic', 'high')).toBe('high');
  });

  test('값이 없으면 앱 기본값을 쓴다', () => {
    expect(effortForProvider('anthropic', undefined)).toBe('medium');
    expect(effortForProvider('ollama', undefined)).toBe('medium');
  });

  test('llama.cpp는 켜고 끄는 것만 구분한다', () => {
    expect(effortForProvider('llamacpp', 'none')).toBe('none');
    expect(effortForProvider('llamacpp', 'high')).toBe('medium');
  });

  test('OpenAI 값은 그대로 둔다', () => {
    expect(effortForProvider('openai', 'xhigh')).toBe('xhigh');
    expect(effortForProvider('openai', 'none')).toBe('none');
  });
});

describe('Anthropic 추론 강도', () => {
  test('effort를 받는 모델에만 보낸다', () => {
    for (const model of [
      'claude-haiku-5-5',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
      'claude-sonnet-4-6',
      'claude-opus-4-5',
      'claude-opus-5-5',
      'claude-fable-5-1',
    ]) {
      expect(supportsAnthropicEffort(model)).toBe(true);
    }
    // 이 모델들은 output_config.effort에 400을 낸다
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1']) {
      expect(supportsAnthropicEffort(model)).toBe(false);
    }
  });

  test('대화 턴은 세션 강도를, 보조 호출은 가장 낮은 강도를 보낸다', () => {
    expect(anthropicEffort('claude-haiku-5-5', false, 'high')).toEqual({
      output_config: { effort: 'high' },
    });
    expect(anthropicEffort('claude-haiku-5-5', true, 'high')).toEqual({
      output_config: { effort: 'low' },
    });
    expect(anthropicEffort('claude-haiku-4-5', false, 'high')).toEqual({});
  });
});

describe('Ollama think', () => {
  test('"끔"과 보조 호출은 생각을 끄고, 나머지는 단계 이름을 보낸다', () => {
    expect(ollamaThink(false, 'none')).toBe(false);
    expect(ollamaThink(true, 'high')).toBe(false);
    expect(ollamaThink(false, 'low')).toBe('low');
    expect(ollamaThink(false, 'xhigh')).toBe('high');
  });
});
