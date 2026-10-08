import type LlmLlamacpp from '@qvac/llm-llamacpp'

import {
  ModelType,
  type CanonicalModelType,
  type EmbedConfig,
  type LlmConfig
} from '@/schemas/index'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { transformEmbedConfig } from '@/plugins/builtin/llamacpp-embedding/transform'
import type { FitRequestPlan } from '@/resources/model-fit/native-probe/create-fit-request'

export type LlamaLoadKind = 'completion' | 'embedding'

const BYTES_PER_MIB = 1024 * 1024

/**
 * The transforms emit some settings with underscores where llama's own
 * argument table spells them with hyphens.
 */
const CANONICAL_KEY: Record<string, string> = {
  ctx_size: 'ctx-size',
  gpu_layers: 'gpu-layers',
  batch_size: 'batch-size',
  ubatch_size: 'ubatch-size',
  flash_attn: 'flash-attn',
  split_mode: 'split-mode',
  main_gpu: 'main-gpu',
  load_mode: 'load-mode'
}

/**
 * Settings that decide how much device memory the load needs, in the spelling
 * each transform emits. `device` and `fit-target` are absent because they are
 * read before this point.
 */
const MEMORY_KEYS: Record<LlamaLoadKind, readonly string[]> = {
  completion: [
    'ctx_size',
    'gpu_layers',
    'load_mode',
    'parallel',
    'cache-type-k',
    'cache-type-v',
    'main-gpu',
    'split-mode',
    'flash-attn',
    'tensor-split',
    'batch-size',
    'ubatch-size',
    'cpu-moe',
    'n-cpu-moe',
    'kv-offload',
    'no-kv-offload',
    'override-tensor',
    'n-cpu-ffn',
    'moe-cache-mib',
    'prefetch-weights',
    'tensor-read-lazy',
    'fit',
    'fit-ctx'
  ],
  embedding: ['gpu_layers', 'batch_size', 'flash_attn', 'main-gpu', 'split-mode', 'tensor-split']
}

/**
 * Shapes the SDK resolves elsewhere, and `rpc-servers`, which it resolves
 * nowhere: the fit request reaches one local machine, so a load spread over
 * remote GPUs would be measured against hardware the caller never named.
 */
const UNSUPPORTED_KEYS: readonly string[] = ['lora', 'projection_model_src', 'rpc-servers']

export function llamaLoadKindFor(modelType: CanonicalModelType): LlamaLoadKind | undefined {
  if (modelType === ModelType.llamacppCompletion) return 'completion'
  if (modelType === ModelType.llamacppEmbedding) return 'embedding'
  return undefined
}

/**
 * A CPU load's weights stay file-backed and evictable, so the fitter projects
 * `fits` for nearly any model the OS could page through. Measured on a 24 GiB
 * M4 Pro: an 18.3 GiB model at 32k context still reports `fits` on
 * `device: 'cpu'`, and it does decode — at 0.1 tok/s. That answer carries no
 * admission information.
 */
function isCpuLoad(transformed: Record<string, string>): boolean {
  return transformed['device']?.toLowerCase() === 'cpu'
}

/**
 * `fit-target` is the free margin the real load asks the engine to leave, in
 * MiB, and a comma-separated list sets it per device. The fit request carries
 * one value for every device, so a list resolves to its largest entry, which is
 * the only reading that cannot project a device as roomier than the load will
 * leave it.
 */
function fitTargetBytes(transformed: Record<string, string>): number | undefined {
  const value = transformed['fit-target']
  if (value === undefined) return undefined

  const targets = value
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry >= 0)

  return targets.length === 0 ? undefined : Math.max(...targets) * BYTES_PER_MIB
}

/**
 * Selects the settings that describe the load and spells them the way llama's
 * argument table does. Everything forwarded is parsed by llama itself, so this
 * layer classifies rather than interprets.
 */
function loadParams(
  loadKind: LlamaLoadKind,
  transformed: Record<string, string>
): { params: Record<string, string> } | { detail: string } {
  const carried = new Set(MEMORY_KEYS[loadKind])
  const params: Record<string, string> = {}

  for (const [key, value] of Object.entries(transformed)) {
    if (UNSUPPORTED_KEYS.includes(key)) {
      return { detail: `unsupported load setting: ${key}` }
    }
    if (!carried.has(key)) continue
    params[CANONICAL_KEY[key] ?? key] = value
  }

  return { params }
}

export interface LlamaFitRequestParams {
  loadKind: LlamaLoadKind
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
  isShardedModel: boolean
  marginBytes?: number | undefined
}

export function createLlamaFitRequest(params: LlamaFitRequestParams): FitRequestPlan {
  const { loadKind } = params

  if (params.isShardedModel) {
    return { supported: false, detail: 'sharded models are not representable' }
  }

  if (loadKind === 'completion' && params.artifacts?.['projectionModelPath'] !== undefined) {
    return { supported: false, detail: 'multimodal projection loads are not representable' }
  }

  const modelConfig = (params.modelConfig ?? {}) as Record<string, unknown>
  const transformed =
    loadKind === 'completion'
      ? transformLlmConfig(modelConfig as LlmConfig)
      : (transformEmbedConfig(modelConfig as EmbedConfig) as unknown as Record<string, string>)

  if (isCpuLoad(transformed)) {
    return { supported: false, detail: 'cpu loads carry no device-memory evidence' }
  }

  const selected = loadParams(loadKind, transformed)
  if ('detail' in selected) return { supported: false, detail: selected.detail }

  const request: LlmLlamacpp.FitRequest = {
    modelPath: params.modelPath,
    params: selected.params
  }

  // A pinned context is also the floor, so the fitter reports on the load the
  // caller asked for rather than one it reduced.
  const ctxSize = Number(selected.params['ctx-size'])
  if (Number.isSafeInteger(ctxSize) && ctxSize > 0) request.minCtxSize = ctxSize

  // The caller's own target and the advisory margin answer different questions
  // — what this load leaves free, and what the models already resident need —
  // so the projection holds to whichever is stricter.
  const margins = [params.marginBytes, fitTargetBytes(transformed)].filter(
    (value): value is number => value !== undefined
  )
  if (margins.length > 0) request.marginBytes = Math.max(...margins)

  return {
    supported: true,
    probe:
      loadKind === 'completion'
        ? { engine: 'llm-llamacpp', request }
        : { engine: 'embed-llamacpp', request }
  }
}
