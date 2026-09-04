import type { FitLlamaProcessConfig, LlamaLoadKind } from '@qvac/model-fit/process'

import {
  ModelType,
  type CanonicalModelType,
  type EmbedConfig,
  type LlmConfig
} from '@/schemas/index'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { transformEmbedConfig } from '@/plugins/builtin/llamacpp-embedding/transform'

/**
 * Keys `@qvac/model-fit` reads as load evidence, in the spelling the SDK's own
 * completion/embedding transforms emit. The package canonicalizes `_` to `-`,
 * so `ctx_size` and `ctx-size` reach the same native setting.
 *
 * This mirrors `SUPPORTED_LOAD_KEYS` in the package's `LlamaLoadConfig.cpp`
 * intersected with what the two transforms can produce. It is a duplicated
 * policy for the duration of the experiment: a key added to a load config
 * without being classified here must not silently change the question the
 * fitter answers, so `partitionParams` refuses the request instead.
 */
const FIT_LOAD_KEYS: Record<LlamaLoadKind, readonly string[]> = {
  completion: [
    'device',
    'ctx_size',
    'gpu_layers',
    'load_mode',
    'parallel',
    'cache-type-k',
    'cache-type-v',
    // Alters KV/compute memory; `model-fit` reads it as evidence.
    'flash-attn',
    'main-gpu',
    'split-mode',
    'tensor-split'
  ],
  embedding: [
    'device',
    'gpu_layers',
    'batch_size',
    'flash_attn',
    'main-gpu',
    'split-mode',
    'tensor-split'
  ]
}

/**
 * Keys that reach the addon but cannot move a load's memory footprint —
 * sampling, generation, logging, and JS-side presentation settings. They are
 * dropped rather than forwarded: `@qvac/model-fit` rejects everything outside
 * its own allowlist, and a key it deliberately ignores must not turn a
 * supported load into `unsupported-config`.
 */
const NON_FIT_KEYS: Record<LlamaLoadKind, readonly string[]> = {
  completion: [
    'temp',
    'top_p',
    'top_k',
    'seed',
    'predict',
    'presence_penalty',
    'frequency_penalty',
    'repeat_penalty',
    'reverse_prompt',
    'n_discarded',
    'tools',
    'verbosity',
    'reasoning_budget',
    'image_tile_mode',
    'image_no_upscale',
    'mmproj-use-gpu',
    'openclCacheDir'
  ],
  embedding: ['pooling', 'attention', 'embd_normalize', 'verbosity', 'openclCacheDir']
}

/** Load-config keys that describe a shape the fitter cannot answer for. */
const UNSUPPORTED_KEYS: readonly string[] = ['lora']

/**
 * A CPU load's weights stay file-backed and evictable, so the fitter projects
 * `fits` for nearly any model the OS could page through. Measured on a 24 GiB
 * M4 Pro against `@qvac/model-fit@0.8.0`: an 18.3 GiB model at 32k context
 * still reports `fits` on `device: 'cpu'` (and it does decode — at 0.1 tok/s).
 * That answer carries no admission information, so it is refused here rather
 * than spending a child process to produce it.
 */
function isCpuLoad(params: Record<string, string>): boolean {
  return params['device']?.toLowerCase() === 'cpu'
}

export type LlamaFitRequestPlan =
  | { supported: true; loadKind: LlamaLoadKind; config: FitLlamaProcessConfig }
  | { supported: false; detail: string }

export interface CreateLlamaFitRequestParams {
  modelType: CanonicalModelType
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
  isShardedModel: boolean
  isMobile: boolean
}

function loadKindFor(modelType: CanonicalModelType): LlamaLoadKind | undefined {
  if (modelType === ModelType.llamacppCompletion) return 'completion'
  if (modelType === ModelType.llamacppEmbedding) return 'embedding'
  return undefined
}

function unsupported(detail: string): LlamaFitRequestPlan {
  return { supported: false, detail }
}

function partitionParams(
  loadKind: LlamaLoadKind,
  transformed: Record<string, string>
): { params: Record<string, string> } | { detail: string } {
  const forwarded = new Set(FIT_LOAD_KEYS[loadKind])
  const dropped = new Set(NON_FIT_KEYS[loadKind])
  const params: Record<string, string> = {}

  for (const [key, value] of Object.entries(transformed)) {
    if (UNSUPPORTED_KEYS.includes(key)) {
      return { detail: `unsupported load setting: ${key}` }
    }
    if (forwarded.has(key)) {
      params[key] = value
      continue
    }
    if (dropped.has(key)) continue
    // Neither fit evidence nor a known non-memory setting: this load carries a
    // setting the SDK cannot classify, so it must not be answered for.
    return { detail: `unclassified load setting: ${key}` }
  }

  return { params }
}

/**
 * Pins the requested context so the fitter reports on the exact load the SDK
 * is about to run. Left unset for an auto context (`0`, "use the model's
 * trained context"), where the package's own floor applies and the fitter
 * stays free to reduce.
 */
function contextFloor(params: Record<string, string>): number | undefined {
  const ctxSize = params['ctx_size']
  if (ctxSize === undefined) return undefined
  const parsed = Number(ctxSize)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

/**
 * Builds a protocol-v2 fit request from the same resolved model config the real
 * load is about to use, or explains why this load cannot be answered for.
 *
 * Structural shapes the SDK owns are refused here so no child process starts.
 * Value-level policy (device names, symbolic GPU selection, context bounds)
 * stays inside `@qvac/model-fit`, which reports `unsupported-config` for it.
 */
export function createLlamaFitRequest(params: CreateLlamaFitRequestParams): LlamaFitRequestPlan {
  if (params.isMobile) {
    return unsupported('mobile has no disposable process boundary')
  }

  const loadKind = loadKindFor(params.modelType)
  if (loadKind === undefined) {
    return unsupported(`model type is not a llama.cpp load: ${params.modelType}`)
  }

  if (params.isShardedModel) {
    return unsupported('sharded models are not representable')
  }

  if (loadKind === 'completion' && params.artifacts?.['projectionModelPath'] !== undefined) {
    return unsupported('multimodal projection loads are not representable')
  }

  const modelConfig = (params.modelConfig ?? {}) as Record<string, unknown>
  const transformed =
    loadKind === 'completion'
      ? transformLlmConfig(modelConfig as LlmConfig)
      : (transformEmbedConfig(modelConfig as EmbedConfig) as unknown as Record<string, string>)

  const partitioned = partitionParams(loadKind, transformed)
  if ('detail' in partitioned) return unsupported(partitioned.detail)

  if (isCpuLoad(partitioned.params)) {
    return unsupported('cpu loads carry no device-memory evidence')
  }

  const nCtxMin = contextFloor(partitioned.params)

  return {
    supported: true,
    loadKind,
    config: {
      // Sharded loads are refused above, so the resolved path is the whole model.
      modelPath: params.modelPath,
      params: partitioned.params,
      ...(nCtxMin !== undefined && { nCtxMin })
    }
  }
}
