import { assessModelFit, SDK_CLIENT_ERROR_CODES, SDK_SERVER_ERROR_CODES } from '@qvac/sdk'
import type { ServeConfig } from '@/serve/core/config/types'
import { loadModelConstants } from '@/serve/core/config/constants'
import { resolveExplicitServeModel, resolveModelAlias } from '@/serve/core/config/models'
import { isModelSrcKey, resolveNestedModelSrcConstants } from '@/serve/core/config/nested-model-src'

/** A model named the way `qvac fit` and `POST /qvac/v1/models/fit` take it. */
export interface FitCandidate {
  /** A `serve.models` alias or an SDK model constant name. */
  model: string
  /** Merged over an alias's own config. Companion sources must name SDK model constants. */
  modelConfig?: Record<string, unknown> | undefined
}

export type FitRequest = Parameters<typeof assessModelFit>[0]['models'][number]
type ModelType = FitRequest['modelType']
type AssessResult = Awaited<ReturnType<typeof assessModelFit>>

export type ModelFitResponse = Omit<AssessResult, 'models'> & {
  object: 'model_fit'
  models: (AssessResult['models'][number] & { model: string })[]
}

export type FitInputErrorCode = 'model_not_found' | 'invalid_model_src'

/** A candidate that names no model, or a companion source that is not a constant. */
export class FitInputError extends Error {
  readonly code: FitInputErrorCode

  constructor(code: FitInputErrorCode, message: string) {
    super(message)
    this.name = 'FitInputError'
    this.code = code
  }
}

/**
 * Assesses named models as if loaded together. Each name resolves as a
 * `serve.models` alias first, then as an SDK model constant.
 *
 * @throws {FitInputError} When a candidate names no model, or a companion
 *   source in its config is not an SDK model constant.
 * @throws The SDK's error when `assessModelFit` refuses the set.
 */
export async function assessNamedModels(
  serveConfig: ServeConfig,
  candidates: readonly FitCandidate[]
): Promise<ModelFitResponse> {
  const requests = candidates.map((candidate) => resolveFitCandidate(serveConfig, candidate))
  const result = await assessModelFit({ models: requests })
  return {
    object: 'model_fit',
    ...result,
    models: result.models.map((entry, i) => ({ model: candidates[i]!.model, ...entry }))
  }
}

/**
 * The SDK fit request for one candidate. An alias is assessed with the config
 * it would load with, `modelConfig` merged over it. A constant is assessed with
 * the engine's defaults and `modelConfig`.
 *
 * @throws {FitInputError} When the candidate names no model, or a companion
 *   source in its config is not an SDK model constant.
 */
export function resolveFitCandidate(serveConfig: ServeConfig, candidate: FitCandidate): FitRequest {
  const requested = candidate.modelConfig ?? {}
  assertConstantSources(requested, 'modelConfig')
  const overrides = resolveNestedModelSrcConstants(requested)

  const alias = resolveModelAlias(serveConfig, candidate.model)
  if (alias) {
    return {
      modelSrc: alias.modelSrc,
      modelType: alias.sdkType as ModelType,
      modelConfig: mergeConfig(alias.config, overrides)
    }
  }

  const constant = loadModelConstants().get(candidate.model)
  if (constant) {
    const resolved = resolveExplicitServeModel(constant.engine || constant.addon, overrides)
    return {
      modelSrc: constant,
      modelType: resolved.sdkType as ModelType,
      modelConfig: resolved.config
    }
  }

  throw new FitInputError(
    'model_not_found',
    `Model "${candidate.model}" is neither a serve.models alias nor an SDK model constant.`
  )
}

/** Whether the SDK refused the load because of a value in its config. */
export function isInvalidModelConfig(err: unknown): boolean {
  // Matched by code: the SDK does not export `PluginLoadConfigValidationFailedError`.
  // Candidates are validated before they reach the SDK, so a request validation
  // failure there is the engine refusing a config value while applying its defaults.
  const code = (err as { code?: unknown } | null)?.code
  return (
    code === SDK_SERVER_ERROR_CODES.PLUGIN_LOAD_CONFIG_VALIDATION_FAILED ||
    code === SDK_CLIENT_ERROR_CODES.REQUEST_VALIDATION_FAILED
  )
}

// Nested objects merge key by key, so `contextParams: { n_ctx }` keeps the
// alias's other context params. A model source is replaced whole.
export function mergeConfig(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key]
    merged[key] =
      !isModelSrcKey(key) && isPlainObject(current) && isPlainObject(value)
        ? mergeConfig(current, value)
        : value
  }
  return merged
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// A candidate never makes the CLI read a path or URL of the caller's choosing:
// paths and URLs come only from serve.models.
function assertConstantSources(config: Record<string, unknown>, path: string): void {
  const constants = loadModelConstants()
  for (const [key, value] of Object.entries(config)) {
    const at = `${path}.${key}`
    if (isModelSrcKey(key)) {
      const sources = Array.isArray(value) ? value : [value]
      if (!sources.every((source) => typeof source === 'string' && constants.has(source))) {
        throw new FitInputError(
          'invalid_model_src',
          `${at} must name an SDK model constant; paths and URLs are only accepted from serve.models.`
        )
      }
      continue
    }
    if (isPlainObject(value)) assertConstantSources(value, at)
  }
}
