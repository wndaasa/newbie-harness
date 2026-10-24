// 모델 등급(오케스트레이션 1단계) 회귀 테스트.
//
// 보조 에이전트에 tier를 주면 등급에 맞는 제공자·모델로 돌아야 한다. 고정하는 것:
//   1. 설정을 비워 두면 기본값 — strong은 지금 모델, fast는 같은 제공자의 저가 모델,
//      local은 지금이 로컬이면 그 모델, 아니면 Ollama 기본 모델
//   2. 지금이 로컬이면 fast는 키가 있는 클라우드로, 키가 없으면 지금 모델로
//   3. 설정값이 기본값보다 우선하고, 제공자만 고르면 그 제공자의 기본 모델
//   4. 모르는 제공자·이상한 값은 저장 전에 걸러진다
//   5. tier가 없으면 자식은 부모와 같은 모델(예전 동작)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

const HOME = mkdtempSync(join(tmpdir(), 'newbie-tiers-'));
process.env.NEWBIE_HOME = HOME;
afterAll(() => {
  try {
    rmSync(HOME, { force: true, recursive: true });
  } catch {
    // Windows에서 잠겨 있으면 임시 폴더 청소는 포기해도 된다
  }
});

const {
  EMPTY_MODEL_TIERS,
  readModelTiers,
  resolveModelTier,
  sanitizeModelTiers,
  writeModelTiers,
} = await import('../src/settings/modelTiers.ts');
const { childModelFor } = await import('../src/tools/subagent/subagent.ts');

function context(provider: string, model: string, keys: string[] = []) {
  return {
    defaultModel: (name: string) => `${name}-default`,
    hasKey: (name: string) => keys.includes(name),
    model,
    provider,
  };
}

describe('기본값', () => {
  const empty = structuredClone(EMPTY_MODEL_TIERS);

  test('클라우드 대화: strong=지금 모델, fast=같은 제공자 저가 모델, local=Ollama', () => {
    const ctx = context('anthropic', 'claude-opus-5-5');
    expect(resolveModelTier('strong', empty, ctx)).toMatchObject({
      isDefault: true,
      model: 'claude-opus-5-5',
      provider: 'anthropic',
    });
    expect(resolveModelTier('fast', empty, ctx)).toMatchObject({ model: 'claude-haiku-5-5', provider: 'anthropic' });
    expect(resolveModelTier('local', empty, ctx)).toMatchObject({ model: 'ollama-default', provider: 'ollama' });
  });

  test('로컬 대화: local=지금 모델, fast=키 있는 클라우드, 키가 없으면 지금 모델', () => {
    expect(resolveModelTier('local', empty, context('vllm', 'qwen'))).toMatchObject({ model: 'qwen', provider: 'vllm' });
    expect(resolveModelTier('fast', empty, context('vllm', 'qwen', ['openai']))).toMatchObject({
      model: 'gpt-5.6-luna',
      provider: 'openai',
    });
    expect(resolveModelTier('fast', empty, context('vllm', 'qwen'))).toMatchObject({ model: 'qwen', provider: 'vllm' });
  });
});

describe('설정값', () => {
  test('설정한 값이 기본값보다 우선하고, 제공자만 고르면 그 제공자의 기본 모델을 쓴다', () => {
    const settings = sanitizeModelTiers({
      fast: { provider: 'openai', model: '' },
      local: { provider: 'llamacpp', model: 'qwen3-8b' },
    });
    const ctx = context('anthropic', 'claude-opus-5-5');
    expect(resolveModelTier('fast', settings, ctx)).toMatchObject({
      isDefault: false,
      model: 'gpt-5.6-luna',
      provider: 'openai',
    });
    expect(resolveModelTier('local', settings, ctx)).toMatchObject({ model: 'qwen3-8b', provider: 'llamacpp' });
  });

  test('모르는 제공자와 이상한 값은 걸러진다', () => {
    const settings = sanitizeModelTiers(
      { fast: { provider: 'evil', model: 'x' }, local: { provider: ' Ollama ', model: '  a\n b ' }, strong: 3 },
      ['anthropic', 'openai', 'ollama'],
    );
    expect(settings.fast).toEqual({ model: '', provider: '' });
    expect(settings.local).toEqual({ model: 'a b', provider: 'ollama' });
    expect(settings.strong).toEqual({ model: '', provider: '' });
  });

  test('저장하고 다시 읽으면 같은 값이고, 넘긴 등급만 바뀐다', () => {
    writeModelTiers({ fast: { provider: 'anthropic', model: 'claude-haiku-5-5' } });
    writeModelTiers({ local: { provider: 'ollama', model: 'gemma4:e4b' } });
    const stored = readModelTiers();
    expect(stored.fast).toEqual({ model: 'claude-haiku-5-5', provider: 'anthropic' });
    expect(stored.local).toEqual({ model: 'gemma4:e4b', provider: 'ollama' });
    writeModelTiers(EMPTY_MODEL_TIERS);
  });
});

describe('보조 에이전트 모델', () => {
  test('tier가 없으면 부모와 같은 모델', () => {
    expect(childModelFor({ model: 'gpt-5.5', provider: 'openai' }, undefined)).toEqual({
      model: 'gpt-5.5',
      provider: 'openai',
    });
  });

  test('fast를 주면 등급 모델로 바뀐다', () => {
    expect(childModelFor({ model: 'gpt-5.5', provider: 'openai' }, 'fast')).toEqual({
      model: 'gpt-5.6-luna',
      provider: 'openai',
    });
  });
});
