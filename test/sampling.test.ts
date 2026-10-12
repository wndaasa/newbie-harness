// 설정창 샘플링 값이 제공자별 이름으로 옮겨지는지.
//
// 비어 있으면 아예 보내지 않아야 한다 — Qwen처럼 generation_config에 권장값이 든
// 모델은 안 건드리는 것이 맞고, 잘못 보낸 0이 기본값을 덮어쓰면 안 된다.

import { describe, expect, test } from 'bun:test';
import {
  anthropicSampling,
  llamaSampling,
  ollamaSampling,
  openAISampling,
  readSampling,
  vllmSampling,
} from '../src/providers/sampling.ts';

describe('샘플링 설정', () => {
  test('비어 있거나 숫자가 아니면 보내지 않는다', () => {
    expect(readSampling({})).toEqual({});
    expect(readSampling({ NEWBIE_TEMPERATURE: '', NEWBIE_TOP_P: 'abc', NEWBIE_TOP_K: ' ' })).toEqual({});
    expect(vllmSampling({})).toEqual({});
    expect(ollamaSampling({})).toEqual({});
  });

  test('vLLM은 여섯 항목을 같은 이름으로 받는다', () => {
    const env = {
      NEWBIE_TEMPERATURE: '0.7',
      NEWBIE_TOP_P: '0.8',
      NEWBIE_TOP_K: '20.9',
      NEWBIE_MIN_P: '0',
      NEWBIE_PRESENCE_PENALTY: '1.5',
      NEWBIE_REPETITION_PENALTY: '1.05',
    };
    expect(vllmSampling(env)).toEqual({
      temperature: 0.7,
      top_p: 0.8,
      // top_k는 개수라 정수로 자른다
      top_k: 20,
      min_p: 0,
      presence_penalty: 1.5,
      repetition_penalty: 1.05,
    });
  });

  test('llama.cpp·LM Studio·Ollama는 반복 페널티 이름이 repeat_penalty다', () => {
    const env = { NEWBIE_TEMPERATURE: '0.6', NEWBIE_REPETITION_PENALTY: '1.1' };
    expect(llamaSampling(env)).toEqual({ temperature: 0.6, repeat_penalty: 1.1 });
    expect(ollamaSampling(env)).toEqual({ options: { temperature: 0.6, repeat_penalty: 1.1 } });
  });

  test('OpenAI는 temperature와 top_p만, Anthropic은 둘 중 temperature만 보낸다', () => {
    const env = { NEWBIE_TEMPERATURE: '0.6', NEWBIE_TOP_P: '0.9', NEWBIE_TOP_K: '20', NEWBIE_MIN_P: '0.1' };
    expect(openAISampling(env)).toEqual({ temperature: 0.6, top_p: 0.9 });
    // 최근 Claude는 temperature와 top_p를 함께 주면 400이다
    expect(anthropicSampling(env)).toEqual({ temperature: 0.6, top_k: 20 });
    expect(anthropicSampling({ NEWBIE_TOP_P: '0.9' })).toEqual({ top_p: 0.9 });
  });
});
