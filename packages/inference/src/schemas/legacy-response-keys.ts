import { z } from 'zod'

export type LegacyResponseKeys<S extends z.ZodRawShape> = Readonly<Partial<Record<keyof S, string>>>

type LegacyResponseFields<S extends z.ZodRawShape, M extends LegacyResponseKeys<S>> = {
  [K in keyof M & keyof S as M[K] & string]: z.ZodOptional<S[K]>
}

/**
 * The schema fields that keep a renamed response key under its previous name for
 * one release. Each one is optional, carries the same value as its replacement,
 * and is marked deprecated in the contract.
 */
export function legacyResponseFields<S extends z.ZodRawShape, M extends LegacyResponseKeys<S>>(
  shape: S,
  legacyKeys: M
): LegacyResponseFields<S, M> {
  return Object.fromEntries(
    Object.entries(legacyKeys)
      .filter(([key]) => key in shape)
      .map(([key, legacyKey]) => [
        legacyKey,
        (shape[key] as z.ZodType).optional().meta({
          deprecated: true,
          'x-replaced-by': key,
          description: `Deprecated, removed in the next release. Use \`${key}\`.`
        })
      ])
  ) as LegacyResponseFields<S, M>
}

/** Copies each renamed response key's value under its previous name. */
export function withLegacyResponseKeys<T extends object>(
  value: T,
  legacyKeys: Readonly<Partial<Record<string, string>>>
): T {
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = { ...source }
  for (const [key, legacyKey] of Object.entries(legacyKeys)) {
    if (legacyKey !== undefined && source[key] !== undefined) result[legacyKey] = source[key]
  }
  return result as T
}

export const LEGACY_FINETUNE_PROGRESS_KEYS = {
  isTrain: 'is_train',
  lossUncertainty: 'loss_uncertainty',
  accuracyUncertainty: 'accuracy_uncertainty',
  globalSteps: 'global_steps',
  currentEpoch: 'current_epoch',
  currentBatch: 'current_batch',
  totalBatches: 'total_batches',
  elapsedMs: 'elapsed_ms',
  etaMs: 'eta_ms'
} as const

export const LEGACY_FINETUNE_STATS_KEYS = {
  trainLoss: 'train_loss',
  trainLossUncertainty: 'train_loss_uncertainty',
  valLoss: 'val_loss',
  valLossUncertainty: 'val_loss_uncertainty',
  trainAccuracy: 'train_accuracy',
  trainAccuracyUncertainty: 'train_accuracy_uncertainty',
  valAccuracy: 'val_accuracy',
  valAccuracyUncertainty: 'val_accuracy_uncertainty',
  learningRate: 'learning_rate',
  globalSteps: 'global_steps',
  epochsCompleted: 'epochs_completed'
} as const

export const LEGACY_EMBED_STATS_KEYS = { ctxSize: 'contextSize' } as const

export const LEGACY_AUDIO_DESCRIPTION_KEYS = {
  keyScale: 'keyscale',
  timeSignature: 'timesignature'
} as const

export const LEGACY_VLA_STATS_KEYS = {
  visionMs: 'vision_ms',
  prefillComputeMs: 'prefill_compute_ms',
  prefillTotalMs: 'prefill_total_ms',
  odeMs: 'ode_ms',
  totalTime: 'total_ms'
} as const
