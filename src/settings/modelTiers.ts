/*
 * 모델 등급 (오케스트레이션 1단계).
 *
 * 보조 에이전트를 띄울 때 지금 대화 모델이 일의 크기에 맞춰 등급을 고른다.
 * 쉬운 조사는 빠르고 싼 모델(fast), 비용 없이 돌릴 일은 로컬 모델(local), 나머지는
 * 지금 대화 모델(strong). 등급마다 어떤 제공자·모델을 쓸지는 설정창에서 바꾸고,
 * 비워 두면 아래 기본값을 쓴다.
 *
 * preferences.json에 섞지 않는다 — 그 파일은 시스템 프롬프트에 실리는 값만 담는다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getNewbieHome } from '../memory/globalNewbie.ts';

export const MODEL_TIERS = ['fast', 'local', 'strong'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm']);

/** 등급 하나의 저장값. 둘 다 비면 기본값을 쓴다는 뜻 */
export type TierChoice = { provider: string; model: string };
export type ModelTierSettings = Record<ModelTier, TierChoice>;

export const EMPTY_MODEL_TIERS: ModelTierSettings = {
  fast: { provider: '', model: '' },
  local: { provider: '', model: '' },
  strong: { provider: '', model: '' },
};

/**
 * 기본값으로 쓰는 저가 모델. 분류기(commandClassifier.ts)와 같은 계열이지만, 분류기는
 * 짧은 판정만 하므로 여기서는 도구를 쓰는 작업을 맡길 수 있는 현행 모델을 둔다
 */
const FAST_DEFAULTS: Record<string, string> = {
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-5.6-luna',
};

export function isModelTier(value: unknown): value is ModelTier {
  return MODEL_TIERS.includes(value as ModelTier);
}

export function getModelTiersPath(): string {
  return join(getNewbieHome(), 'model-tiers.json');
}

export function readModelTiers(): ModelTierSettings {
  const path = getModelTiersPath();
  if (!existsSync(path)) return structuredClone(EMPTY_MODEL_TIERS);
  try {
    return sanitizeModelTiers(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // 파일이 깨졌다고 보조 에이전트를 못 띄우면 안 된다. 기본값으로 간다
    return structuredClone(EMPTY_MODEL_TIERS);
  }
}

export function writeModelTiers(patch: unknown): ModelTierSettings {
  const next = sanitizeModelTiers({ ...readModelTiers(), ...(patch as object) });
  const path = getModelTiersPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** 어떤 값이 와도 ModelTierSettings 모양으로 만든다 (파일·IPC 양쪽 입구) */
export function sanitizeModelTiers(raw: unknown, providers?: readonly string[]): ModelTierSettings {
  const source = (raw ?? {}) as Record<string, unknown>;
  const result = structuredClone(EMPTY_MODEL_TIERS);
  for (const tier of MODEL_TIERS) {
    const entry = (source[tier] ?? {}) as Record<string, unknown>;
    const provider = typeof entry.provider === 'string' ? entry.provider.trim().toLowerCase() : '';
    const model = typeof entry.model === 'string' ? entry.model.replace(/\s+/g, ' ').trim() : '';
    if (providers && provider && !providers.includes(provider)) continue;
    result[tier] = { provider, model: model.slice(0, 200) };
  }
  return result;
}

export type TierContext = {
  /** 지금 대화의 제공자·모델 */
  provider: string;
  model: string;
  /** 제공자별 기본 모델 (config.getDefaultModel) */
  defaultModel: (provider: string) => string;
  /** 키가 있는 클라우드 제공자인가 */
  hasKey: (provider: string) => boolean;
};

export type ResolvedTier = TierChoice & {
  /** 설정값이 아니라 기본값으로 정해졌는가 (설정창 안내용) */
  isDefault: boolean;
};

/**
 * 등급을 실제 제공자·모델로 푼다.
 *
 * 기본값:
 * - strong: 지금 대화 모델
 * - fast: 지금 제공자의 저가 모델. 지금이 로컬이면 키가 있는 클라우드(Anthropic →
 *   OpenAI)의 저가 모델, 키가 하나도 없으면 지금 대화 모델
 * - local: 지금이 로컬이면 그 모델, 아니면 Ollama의 기본 모델
 *
 * 제공자만 고르고 모델을 비우면 그 제공자의 기본 모델(fast는 저가 모델)을 쓴다
 */
export function resolveModelTier(
  tier: ModelTier,
  settings: ModelTierSettings,
  context: TierContext,
): ResolvedTier {
  const saved = settings[tier];
  const fallback = defaultTier(tier, context);
  if (!saved.provider && !saved.model) return { ...fallback, isDefault: true };

  const provider = saved.provider || fallback.provider;
  const model =
    saved.model ||
    (tier === 'fast' ? FAST_DEFAULTS[provider] : undefined) ||
    (provider === context.provider ? context.model : context.defaultModel(provider));
  return { isDefault: false, model, provider };
}

function defaultTier(tier: ModelTier, context: TierContext): TierChoice {
  const current = { model: context.model, provider: context.provider };
  if (tier === 'strong') return current;
  if (tier === 'local') {
    if (LOCAL_PROVIDERS.has(context.provider)) return current;
    return { model: context.defaultModel('ollama'), provider: 'ollama' };
  }
  // fast
  if (FAST_DEFAULTS[context.provider]) {
    return { model: FAST_DEFAULTS[context.provider], provider: context.provider };
  }
  for (const provider of ['anthropic', 'openai']) {
    if (context.hasKey(provider)) return { model: FAST_DEFAULTS[provider], provider };
  }
  return current;
}

/** 화면·보고에 쓰는 등급 이름 */
export const MODEL_TIER_LABELS: Record<ModelTier, string> = {
  fast: '빠름',
  local: '로컬',
  strong: '강함',
};
