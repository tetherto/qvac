import {
  ModelTypeAliases,
  normalizeModelType,
  type CanonicalModelType
} from '@/schemas/model-types'
import { inferModelTypeFromModelSrc } from '@/schemas/model-src-utils'
import type { LlmConfigInput } from '@/schemas/llamacpp-config'
import type { GenerationParams, ResponseFormat } from '@/schemas/completion-stream'
import type { DecisionConfigInput } from '@/schemas/decision'
import type { RerankConfigInput } from '@/schemas/rerank'

export interface LegacyLlmConfig {
  /** @deprecated Use `ctxSize`. */
  ctx_size?: LlmConfigInput['ctxSize']
  /** @deprecated Use `temperature`. */
  temp?: LlmConfigInput['temperature']
  /** @deprecated Use `topP`. */
  top_p?: LlmConfigInput['topP']
  /** @deprecated Use `topK`. */
  top_k?: LlmConfigInput['topK']
  /** @deprecated Use `gpuLayers`. */
  gpu_layers?: LlmConfigInput['gpuLayers']
  /** @deprecated Use `systemPrompt`. */
  system_prompt?: LlmConfigInput['systemPrompt']
  /** @deprecated Use `loadMode`. */
  load_mode?: LlmConfigInput['loadMode']
  /** @deprecated Use `presencePenalty`. */
  presence_penalty?: LlmConfigInput['presencePenalty']
  /** @deprecated Use `frequencyPenalty`. */
  frequency_penalty?: LlmConfigInput['frequencyPenalty']
  /** @deprecated Use `repeatPenalty`. */
  repeat_penalty?: LlmConfigInput['repeatPenalty']
  /** @deprecated Use `stopSequences`. */
  stop_sequences?: LlmConfigInput['stopSequences']
  /** @deprecated Use `cacheCheckpoints`. */
  cache_checkpoints?: LlmConfigInput['cacheCheckpoints']
  /** @deprecated Use `cacheCheckpointsMaxBytes`. */
  cache_checkpoints_max_bytes?: LlmConfigInput['cacheCheckpointsMaxBytes']
  /** @deprecated Use `cacheCheckpointStorage`. */
  cache_checkpoint_storage?: LlmConfigInput['cacheCheckpointStorage']
  /** @deprecated Use `cacheCheckpointDir`. */
  cache_checkpoint_dir?: LlmConfigInput['cacheCheckpointDir']
  /** @deprecated Use `cacheShareAcrossKeys`. */
  cache_share_across_keys?: LlmConfigInput['cacheShareAcrossKeys']
  /** @deprecated Use `cacheRamMib`. */
  cache_ram_mib?: LlmConfigInput['cacheRamMib']
  /** @deprecated Use `cacheTypeK`. */
  'cache-type-k'?: LlmConfigInput['cacheTypeK']
  /** @deprecated Use `cacheTypeV`. */
  'cache-type-v'?: LlmConfigInput['cacheTypeV']
  /** @deprecated Use `mainGpu`. */
  'main-gpu'?: LlmConfigInput['mainGpu']
  /** @deprecated Use `rpcServers`. */
  'rpc-servers'?: LlmConfigInput['rpcServers']
  /** @deprecated Use `splitMode`. */
  'split-mode'?: LlmConfigInput['splitMode']
  /** @deprecated Use `flashAttention`. */
  'flash-attn'?: LlmConfigInput['flashAttention']
  /** @deprecated Use `tensorSplit`. */
  'tensor-split'?: LlmConfigInput['tensorSplit']
  /** @deprecated Use `batchSize`. */
  'batch-size'?: LlmConfigInput['batchSize']
  /** @deprecated Use `ubatchSize`. */
  'ubatch-size'?: LlmConfigInput['ubatchSize']
  /** @deprecated Use `cpuMoe`. */
  'cpu-moe'?: LlmConfigInput['cpuMoe']
  /** @deprecated Use `nCpuMoe`. */
  'n-cpu-moe'?: LlmConfigInput['nCpuMoe']
  /** @deprecated Use `kvOffload`. */
  'kv-offload'?: LlmConfigInput['kvOffload']
  /** @deprecated Use `imageMaxTokens`. */
  'image-max-tokens'?: LlmConfigInput['imageMaxTokens']
  /** @deprecated Use `imageMinTokens`. */
  'image-min-tokens'?: LlmConfigInput['imageMinTokens']
  /** @deprecated Use `imageMaxMegapixels`. */
  'image-max-megapixels'?: LlmConfigInput['imageMaxMegapixels']
  /** @deprecated Use `threadsBatch`. */
  'threads-batch'?: LlmConfigInput['threadsBatch']
  /** @deprecated Use `cpuMask`. */
  'cpu-mask'?: LlmConfigInput['cpuMask']
  /** @deprecated Use `cpuMaskBatch`. */
  'cpu-mask-batch'?: LlmConfigInput['cpuMaskBatch']
  /** @deprecated Use `overrideTensor`. */
  'override-tensor'?: LlmConfigInput['overrideTensor']
  /** @deprecated Use `nCpuFfn`. */
  'n-cpu-ffn'?: LlmConfigInput['nCpuFfn']
  /** @deprecated Use `moeCacheMib`. */
  'moe-cache-mib'?: LlmConfigInput['moeCacheMib']
  /** @deprecated Use `prefetchWeights`. */
  'prefetch-weights'?: LlmConfigInput['prefetchWeights']
  /** @deprecated Use `tensorReadLazy`. */
  'tensor-read-lazy'?: LlmConfigInput['tensorReadLazy']
  /** @deprecated Use `coremlFfn`. */
  'coreml-ffn'?: LlmConfigInput['coremlFfn']
  /** @deprecated Use `coremlFfnSplit`. */
  'coreml-ffn-split'?: LlmConfigInput['coremlFfnSplit']
  /** @deprecated Use `coremlFfnCache`. */
  'coreml-ffn-cache'?: LlmConfigInput['coremlFfnCache']
  /** @deprecated Use `fitTarget`. */
  'fit-target'?: LlmConfigInput['fitTarget']
  /** @deprecated Use `fitCtx`. */
  'fit-ctx'?: LlmConfigInput['fitCtx']
  /** @deprecated Use `reasoningBudget`. */
  reasoning_budget?: LlmConfigInput['reasoningBudget']
  /** @deprecated Use `specType`. */
  spec_type?: LlmConfigInput['specType']
  /** @deprecated Use `specDraftNMax`. */
  spec_draft_n_max?: LlmConfigInput['specDraftNMax']
  /** @deprecated Use `specDraftNMin`. */
  spec_draft_n_min?: LlmConfigInput['specDraftNMin']
  /** @deprecated Use `specDraftPMin`. */
  spec_draft_p_min?: LlmConfigInput['specDraftPMin']
  /** @deprecated Use `imageTileMode`. */
  image_tile_mode?: LlmConfigInput['imageTileMode']
  /** @deprecated Use `imageNoUpscale`. */
  image_no_upscale?: LlmConfigInput['imageNoUpscale']
  /** @deprecated Use `mmprojUseGpu`. */
  'mmproj-use-gpu'?: LlmConfigInput['mmprojUseGpu']
}

export interface LegacyGenerationParams {
  /** @deprecated Use `temperature`. */
  temp?: GenerationParams['temperature']
  /** @deprecated Use `topP`. */
  top_p?: GenerationParams['topP']
  /** @deprecated Use `topK`. */
  top_k?: GenerationParams['topK']
  /** @deprecated Use `frequencyPenalty`. */
  frequency_penalty?: GenerationParams['frequencyPenalty']
  /** @deprecated Use `presencePenalty`. */
  presence_penalty?: GenerationParams['presencePenalty']
  /** @deprecated Use `repeatPenalty`. */
  repeat_penalty?: GenerationParams['repeatPenalty']
  /** @deprecated Use `reasoningBudget`. */
  reasoning_budget?: GenerationParams['reasoningBudget']
  /** @deprecated Use `toolChoice`. */
  tool_choice?: GenerationParams['toolChoice']
  /** @deprecated Use `parallelToolCalls`. */
  parallel_tool_calls?: GenerationParams['parallelToolCalls']
}

type JsonSchemaResponseFormat = Extract<ResponseFormat, { type: 'json_schema' }>

export type LegacyJsonSchemaResponseFormat = Omit<JsonSchemaResponseFormat, 'jsonSchema'> & {
  /** @deprecated Use `jsonSchema`. */
  json_schema: JsonSchemaResponseFormat['jsonSchema']
}

export type WithLegacyCompletionParams<P> = Omit<P, 'generationParams' | 'responseFormat'> & {
  generationParams?:
    (NonNullable<P[Extract<keyof P, 'generationParams'>]> & LegacyGenerationParams) | undefined
  responseFormat?:
    P[Extract<keyof P, 'responseFormat'>] | LegacyJsonSchemaResponseFormat | undefined
}

export interface LegacyEmbedLlamacppConfig<C extends DecisionConfigInput | RerankConfigInput> {
  /** @deprecated Use `gpuLayers`. */
  gpu_layers?: C['gpuLayers']
  /** @deprecated Use `batchSize`. */
  batch_size?: C['batchSize']
  /** @deprecated Use `threadsBatch`. */
  'threads-batch'?: C['threadsBatch']
  /** @deprecated Use `flashAttention`. */
  flash_attn?: C['flashAttention']
  /** @deprecated Use `mainGpu`. */
  'main-gpu'?: C['mainGpu']
  /** @deprecated Use `splitMode`. */
  'split-mode'?: C['splitMode']
  /** @deprecated Use `tensorSplit`. */
  'tensor-split'?: C['tensorSplit']
}

export type LegacyModelConfigs = {
  'llamacpp-completion': LegacyLlmConfig
  'llamacpp-decision': LegacyEmbedLlamacppConfig<DecisionConfigInput>
  'llamacpp-rerank': LegacyEmbedLlamacppConfig<RerankConfigInput>
}

type CanonicalOf<T> = T extends keyof typeof ModelTypeAliases ? (typeof ModelTypeAliases)[T] : T

export type LegacyModelConfigOf<T> =
  CanonicalOf<T> extends keyof LegacyModelConfigs ? LegacyModelConfigs[CanonicalOf<T>] : unknown

export type WithLegacyModelConfig<O> = O extends { modelType: infer T; modelConfig?: infer C }
  ? Omit<O, 'modelConfig'> & { modelConfig?: C & LegacyModelConfigOf<T> }
  : O

export type LegacyKeySpec = {
  readonly renames?: Readonly<Record<string, string>>
  readonly nested?: Readonly<Record<string, LegacyKeySpec>>
}

/**
 * Receives each deprecated key's path, its replacement's path, and whether the
 * deprecated value was ignored because the replacement was also set.
 */
export type LegacyKeyWarn = (legacyPath: string, replacementPath: string, ignored?: boolean) => void

const LLM_CONFIG_KEYS: LegacyKeySpec = {
  renames: {
    ctx_size: 'ctxSize',
    temp: 'temperature',
    top_p: 'topP',
    top_k: 'topK',
    gpu_layers: 'gpuLayers',
    system_prompt: 'systemPrompt',
    load_mode: 'loadMode',
    presence_penalty: 'presencePenalty',
    frequency_penalty: 'frequencyPenalty',
    repeat_penalty: 'repeatPenalty',
    stop_sequences: 'stopSequences',
    cache_checkpoints: 'cacheCheckpoints',
    cache_checkpoints_max_bytes: 'cacheCheckpointsMaxBytes',
    cache_checkpoint_storage: 'cacheCheckpointStorage',
    cache_checkpoint_dir: 'cacheCheckpointDir',
    cache_share_across_keys: 'cacheShareAcrossKeys',
    cache_ram_mib: 'cacheRamMib',
    'cache-type-k': 'cacheTypeK',
    'cache-type-v': 'cacheTypeV',
    'main-gpu': 'mainGpu',
    'rpc-servers': 'rpcServers',
    'split-mode': 'splitMode',
    'flash-attn': 'flashAttention',
    'tensor-split': 'tensorSplit',
    'batch-size': 'batchSize',
    'ubatch-size': 'ubatchSize',
    'cpu-moe': 'cpuMoe',
    'n-cpu-moe': 'nCpuMoe',
    'kv-offload': 'kvOffload',
    'image-max-tokens': 'imageMaxTokens',
    'image-min-tokens': 'imageMinTokens',
    'image-max-megapixels': 'imageMaxMegapixels',
    'threads-batch': 'threadsBatch',
    'cpu-mask': 'cpuMask',
    'cpu-mask-batch': 'cpuMaskBatch',
    'override-tensor': 'overrideTensor',
    'n-cpu-ffn': 'nCpuFfn',
    'moe-cache-mib': 'moeCacheMib',
    'prefetch-weights': 'prefetchWeights',
    'tensor-read-lazy': 'tensorReadLazy',
    'coreml-ffn': 'coremlFfn',
    'coreml-ffn-split': 'coremlFfnSplit',
    'coreml-ffn-cache': 'coremlFfnCache',
    'fit-target': 'fitTarget',
    'fit-ctx': 'fitCtx',
    reasoning_budget: 'reasoningBudget',
    spec_type: 'specType',
    spec_draft_n_max: 'specDraftNMax',
    spec_draft_n_min: 'specDraftNMin',
    spec_draft_p_min: 'specDraftPMin',
    image_tile_mode: 'imageTileMode',
    image_no_upscale: 'imageNoUpscale',
    'mmproj-use-gpu': 'mmprojUseGpu'
  }
}

const COMPLETION_PARAMS_KEYS: LegacyKeySpec = {
  nested: {
    generationParams: {
      renames: {
        temp: 'temperature',
        top_p: 'topP',
        top_k: 'topK',
        frequency_penalty: 'frequencyPenalty',
        presence_penalty: 'presencePenalty',
        repeat_penalty: 'repeatPenalty',
        reasoning_budget: 'reasoningBudget',
        tool_choice: 'toolChoice',
        parallel_tool_calls: 'parallelToolCalls'
      }
    },
    responseFormat: { renames: { json_schema: 'jsonSchema' } }
  }
}

const EMBED_LLAMACPP_CONFIG_KEYS: LegacyKeySpec = {
  renames: {
    gpu_layers: 'gpuLayers',
    batch_size: 'batchSize',
    'threads-batch': 'threadsBatch',
    flash_attn: 'flashAttention',
    'main-gpu': 'mainGpu',
    'split-mode': 'splitMode',
    'tensor-split': 'tensorSplit'
  }
}

export const LEGACY_MODEL_CONFIG_KEYS: Partial<Record<CanonicalModelType, LegacyKeySpec>> = {
  'llamacpp-completion': LLM_CONFIG_KEYS,
  'llamacpp-decision': EMBED_LLAMACPP_CONFIG_KEYS,
  'llamacpp-rerank': EMBED_LLAMACPP_CONFIG_KEYS
}

export const LEGACY_REQUEST_KEYS: Readonly<Record<string, LegacyKeySpec>> = {
  completionStream: COMPLETION_PARAMS_KEYS,
  completionOrchestrate: COMPLETION_PARAMS_KEYS,
  batchCompletionStream: { nested: { prompts: COMPLETION_PARAMS_KEYS } }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function joinPath(prefix: string, key: string) {
  return prefix === '' ? key : `${prefix}.${key}`
}

function renameObject(
  value: Record<string, unknown>,
  spec: LegacyKeySpec,
  warn: LegacyKeyWarn,
  path: string
): Record<string, unknown> {
  let result = value
  for (const [legacyKey, key] of Object.entries(spec.renames ?? {})) {
    if (!(legacyKey in result)) continue
    if (result === value) result = { ...value }
    const ignored = key in result
    if (!ignored) result[key] = result[legacyKey]
    delete result[legacyKey]
    warn(joinPath(path, legacyKey), joinPath(path, key), ignored)
  }
  for (const [key, childSpec] of Object.entries(spec.nested ?? {})) {
    const child = result[key]
    const renamed = renameLegacyKeys(child, childSpec, warn, joinPath(path, key))
    if (renamed === child) continue
    if (result === value) result = { ...value }
    result[key] = renamed
  }
  return result
}

export function renameLegacyKeys<T>(
  value: T,
  spec: LegacyKeySpec,
  warn: LegacyKeyWarn,
  path = ''
): T {
  if (Array.isArray(value)) {
    let changed = false
    const items = value.map((item, index) => {
      const renamed = renameLegacyKeys(item, spec, warn, `${path}[${index}]`)
      if (renamed !== item) changed = true
      return renamed
    })
    return (changed ? items : value) as T
  }
  if (!isPlainObject(value)) return value
  return renameObject(value, spec, warn, path) as T
}

export type CamelCaseCompletionParams<P> = Omit<P, 'generationParams' | 'responseFormat'> & {
  generationParams?: GenerationParams | undefined
  responseFormat?: ResponseFormat | undefined
}

export function renameLegacyCompletionParams<P extends object>(
  params: P,
  warn: LegacyKeyWarn
): CamelCaseCompletionParams<P> {
  return renameLegacyKeys(params, COMPLETION_PARAMS_KEYS, warn) as CamelCaseCompletionParams<P>
}

export function renameLegacyModelConfigKeys<T>(
  modelType: unknown,
  modelConfig: T,
  warn: LegacyKeyWarn,
  path = 'modelConfig'
): T {
  if (typeof modelType !== 'string') return modelConfig
  const spec = LEGACY_MODEL_CONFIG_KEYS[normalizeModelType(modelType) as CanonicalModelType]
  return spec ? renameLegacyKeys(modelConfig, spec, warn, path) : modelConfig
}

function withPreviousKeys(value: unknown, spec: LegacyKeySpec): unknown {
  if (Array.isArray(value)) return value.map((item) => withPreviousKeys(item, spec))
  if (!isPlainObject(value)) return value
  const previous = new Map(Object.entries(spec.renames ?? {}).map(([legacy, key]) => [key, legacy]))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const childSpec = spec.nested?.[key]
      return [previous.get(key) ?? key, childSpec ? withPreviousKeys(item, childSpec) : item]
    })
  )
}

/**
 * The model config with each renamed key under its spelling before the
 * camelCase rename. Model ids and KV cache folders hash this form, so a load
 * keeps the id and the saved caches it had in earlier releases. It outlives the
 * deprecated keys: removing them must keep this mapping.
 */
export function modelConfigIdentity(
  modelType: string,
  modelConfig: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const spec = LEGACY_MODEL_CONFIG_KEYS[normalizeModelType(modelType) as CanonicalModelType]
  return spec
    ? (withPreviousKeys(modelConfig, spec) as Record<string, unknown> | undefined)
    : modelConfig
}

function renameLoadModelConfig<T extends Record<string, unknown>>(
  load: T,
  warn: LegacyKeyWarn,
  path: string
): T {
  if (!('modelConfig' in load)) return load
  const modelConfig = renameLegacyModelConfigKeys(
    load['modelType'] ?? inferModelTypeFromModelSrc(load['modelSrc']),
    load['modelConfig'],
    warn,
    joinPath(path, 'modelConfig')
  )
  return modelConfig === load['modelConfig'] ? load : { ...load, modelConfig }
}

export function renameLegacyRequestKeys<T>(request: T, warn: LegacyKeyWarn): T {
  if (!isPlainObject(request)) return request
  let result: Record<string, unknown> = request
  const type = result['type']

  if (type === 'loadModel') {
    result = renameLoadModelConfig(result, warn, '')
  } else if (type === 'assessModelFit' && Array.isArray(result['models'])) {
    const models = result['models'] as unknown[]
    const renamed = models.map((load, index) =>
      isPlainObject(load) ? renameLoadModelConfig(load, warn, `models[${index}]`) : load
    )
    if (renamed.some((load, index) => load !== models[index])) {
      result = { ...result, models: renamed }
    }
  }

  const spec = typeof type === 'string' ? LEGACY_REQUEST_KEYS[type] : undefined
  if (spec) result = renameLegacyKeys(result, spec, warn)
  return result as T
}

function renamePatternDefaults(
  defaults: Record<string, unknown>,
  warn: LegacyKeyWarn,
  path: string
): Record<string, unknown> {
  let result = defaults
  for (const [modelType, modelConfig] of Object.entries(defaults)) {
    const renamed = renameLegacyModelConfigKeys(
      modelType,
      modelConfig,
      warn,
      `${path}.${modelType}`
    )
    if (renamed === modelConfig) continue
    if (result === defaults) result = { ...defaults }
    result[modelType] = renamed
  }
  return result
}

export function renameLegacyConfigKeys<T>(config: T, warn: LegacyKeyWarn): T {
  if (!isPlainObject(config) || !Array.isArray(config['deviceDefaults'])) return config
  const patterns = config['deviceDefaults'] as unknown[]
  const renamed = patterns.map((pattern, index) => {
    if (!isPlainObject(pattern) || !isPlainObject(pattern['defaults'])) return pattern
    const defaults = renamePatternDefaults(
      pattern['defaults'],
      warn,
      `deviceDefaults[${index}].defaults`
    )
    return defaults === pattern['defaults'] ? pattern : { ...pattern, defaults }
  })
  const changed = renamed.some((pattern, index) => pattern !== patterns[index])
  return (changed ? { ...config, deviceDefaults: renamed } : config) as T
}

export function createLegacyKeyWarner(log: (message: string) => void): LegacyKeyWarn {
  const warned = new Set<string>()
  return (legacyPath, replacementPath, ignored = false) => {
    const pathWithoutIndexes = legacyPath.replace(/\[\d+\]/g, '[]')
    if (warned.has(pathWithoutIndexes)) return
    warned.add(pathWithoutIndexes)
    const deprecation = `"${legacyPath}" is deprecated and will be removed in the next release. Use "${replacementPath}" instead.`
    log(
      ignored
        ? `${deprecation} Its value was ignored because "${replacementPath}" is also set.`
        : deprecation
    )
  }
}
