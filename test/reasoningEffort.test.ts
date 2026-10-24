// 제공자별 추론 강도 회귀 테스트.
//
// 추론 강도는 OpenAI와 vLLM 요청에만 실리고 있었다. Anthropic 요청에는 빠져 있어
// Haiku 5.5가 모델 기본값으로 생각한 뒤, 생각에서 쓴 요약을 이미 보여 준 것처럼
// "앞서 드린 요약이 유효합니다"로만 답한 사례가 있었다. 강도는 세션에 하나만
// 저장되므로 제공자를 바꾸면 그 제공자가 받지 않는 값이 남을 수 있다.

import { afterEach, describe, expect, test } from 'bun:test';
import { anthropicEffort, supportsAnthropicEffort } from '../src/providers/anthropic.ts';
import { fetchContextWindow, resolveContextWindow } from '../src/providers/contextWindow.ts';
import {
  fetchAnthropicModelInfo,
  parseAnthropicModelInfo,
} from '../src/providers/modelCapabilities.ts';
import { ollamaThink } from '../src/providers/ollama.ts';
import {
  effortForProvider,
  effortLevelsFor,
  reasoningEffortOptions,
} from '../src/providers/openaiResponses.ts';

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

describe('Models API로 조회한 Anthropic 정보', () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  function mockModel(body: unknown) {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    globalThis.fetch = (async () => Response.json(body)) as never;
  }

  test('응답을 창 크기와 강도 단계로 읽는다', () => {
    const info = parseAnthropicModelInfo({
      max_input_tokens: 1_000_000,
      capabilities: {
        effort: {
          supported: true,
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
          xhigh: { supported: true },
          max: { supported: true },
        },
      },
    });
    expect(info).toEqual({
      contextWindow: 1_000_000,
      effortSupported: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(parseAnthropicModelInfo({})).toEqual({
      contextWindow: null,
      effortSupported: null,
      efforts: [],
    });
  });

  test('조회한 창 크기가 200K 기본값을 대신한다', async () => {
    expect(resolveContextWindow('anthropic', 'claude-caps-window')).toBe(200_000);
    mockModel({ max_input_tokens: 1_000_000, capabilities: {} });
    expect(await fetchContextWindow('anthropic', 'claude-caps-window')).toBe(1_000_000);
    expect(resolveContextWindow('anthropic', 'claude-caps-window')).toBe(1_000_000);
  });

  test('조회한 단계가 메뉴와 요청 값을 정한다', async () => {
    // 조회 전에는 이름 규칙으로 판정한 기본 단계
    expect(effortLevelsFor('anthropic', 'claude-sonnet-9-caps')).toEqual(['low', 'medium', 'high']);
    expect(effortLevelsFor('anthropic', 'claude-caps-effort')).toEqual([]);
    mockModel({
      max_input_tokens: 1_000_000,
      capabilities: {
        effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: true } },
      },
    });
    await fetchAnthropicModelInfo('claude-caps-effort');
    expect(reasoningEffortOptions('anthropic', 'claude-caps-effort').map(o => o.value)).toEqual([
      'low',
      'high',
      'max',
    ]);
    expect(effortForProvider('anthropic', 'max', 'claude-caps-effort')).toBe('max');
    // medium은 없는 단계라 거리가 같은 둘 중 낮은 쪽으로
    expect(effortForProvider('anthropic', 'medium', 'claude-caps-effort')).toBe('low');
    expect(effortForProvider('anthropic', 'xhigh', 'claude-caps-effort')).toBe('high');
    expect(anthropicEffort('claude-caps-effort', true, 'max')).toEqual({ output_config: { effort: 'low' } });
  });

  test('조회 결과가 effort 미지원이면 이름 규칙보다 우선한다', async () => {
    mockModel({ max_input_tokens: 200_000, capabilities: { effort: { supported: false } } });
    await fetchAnthropicModelInfo('claude-opus-9-caps');
    expect(supportsAnthropicEffort('claude-opus-9-caps')).toBe(false);
    expect(anthropicEffort('claude-opus-9-caps', false, 'high')).toEqual({});
  });

  test('키가 없으면 조회하지 않고 기본값을 유지한다', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = (async () => {
      throw new Error('호출되면 안 된다');
    }) as never;
    expect(await fetchAnthropicModelInfo('claude-caps-nokey')).toBeNull();
    expect(resolveContextWindow('anthropic', 'claude-caps-nokey')).toBe(200_000);
  });
});

describe('OpenAI 창 크기 재정의', () => {
  test('OPENAI_CONTEXT_WINDOW가 표보다 우선한다', () => {
    process.env.OPENAI_CONTEXT_WINDOW = '1050000';
    try {
      expect(resolveContextWindow('openai', 'gpt-5.5')).toBe(1_050_000);
    } finally {
      delete process.env.OPENAI_CONTEXT_WINDOW;
    }
    expect(resolveContextWindow('openai', 'gpt-5.5')).toBe(400_000);
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
