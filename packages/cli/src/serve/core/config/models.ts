import type { ModelConstant } from '@qvac/sdk'
import { modelFitPolicySchema, type ModelFitPolicy } from '@qvac/sdk/schemas'
import type { ResolvedModelEntry, ServeConfig } from '@/serve/core/config/types'
import { SDCPP_VIDEO_TYPE, resolveSdcppVideoAlias } from '@/serve/core/config/aliases/sdcpp-video'
import { endpointCategoryFor } from '@/serve/core/config/endpoint-category'
import { loadModelConstants } from '@/serve/core/config/constants'
import { resolveNestedModelSrcConstants } from '@/serve/core/config/nested-model-src'

export interface ConstantModelEntry {
  model: string
  type?: string
  default?: boolean
  preload?: boolean
  modelFitPolicy?: string
  fallbackSrc?: string
  config?: Record<string, unknown>
}

export interface ExplicitModelEntry {
  src?: string
  type: string
  default?: boolean
  preload?: boolean
  modelFitPolicy?: string
  fallbackSrc?: string
  config?: Record<string, unknown>
}

export type RawModelEntry = string | ConstantModelEntry | ExplicitModelEntry

export function resolveServeModels(
  rawModels: Record<string, RawModelEntry>
): Map<string, ResolvedModelEntry> {
  const models = new Map<string, ResolvedModelEntry>()

  for (const [alias, entry] of Object.entries(rawModels)) {
    if (typeof entry === 'string') {
      models.set(alias, resolveModelConstant(alias, { model: entry }))
    } else if (isConstantModelEntry(entry)) {
      models.set(alias, resolveModelConstant(alias, entry))
    } else {
      models.set(alias, parseExplicitEntry(alias, entry))
    }
  }

  return models
}

const VIRTUAL_SDK_WHISPER_AUDIO_TRANSLATION = 'whispercpp-audio-translation'

/**
 * Resolves explicit serve.models entries: maps the virtual whisper translation
 * alias to whispercpp-transcription + forces translate=true for SDK loadModel
 * (whisper modelConfig is flat whisper fields, not a nested whisperConfig object).
 * Exported for unit tests.
 */
export function resolveExplicitServeModel(
  type: string,
  config: Record<string, unknown>
): {
  sdkType: string
  endpointCategory: string
  config: Record<string, unknown>
} {
  if (type === SDCPP_VIDEO_TYPE) {
    return resolveSdcppVideoAlias(config)
  }

  if (type !== VIRTUAL_SDK_WHISPER_AUDIO_TRANSLATION) {
    return {
      sdkType: type,
      endpointCategory: endpointCategoryFor(type, config),
      config: { ...config }
    }
  }

  const out: Record<string, unknown> = { ...config }
  const nested = out['whisperConfig']
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
      out[k] = v
    }
    delete out['whisperConfig']
  }

  if (out['translate'] === false) {
    console.warn(
      'serve.models: whispercpp-audio-translation forces translate=true (ignoring translate=false)'
    )
  }
  out['translate'] = true

  return {
    sdkType: 'whispercpp-transcription',
    endpointCategory: 'audio-translation',
    config: out
  }
}

function resolveForAlias(
  alias: string,
  type: string,
  config: Record<string, unknown>
): ReturnType<typeof resolveExplicitServeModel> {
  try {
    return resolveExplicitServeModel(type, config)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`serve.models.${alias}.${message}`)
  }
}

function isConstantModelEntry(entry: unknown): entry is ConstantModelEntry {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    'model' in entry &&
    typeof (entry as Record<string, unknown>)['model'] === 'string'
  )
}

export function resolveModelConstant(alias: string, entry: ConstantModelEntry): ResolvedModelEntry {
  const model = loadModelConstants().get(entry.model)
  if (!model) {
    throw new Error(
      `serve.models.${alias}: unknown model constant "${entry.model}". ` +
        'Use a valid SDK model name (e.g. QWEN3_600M_INST_Q4).'
    )
  }

  const rawConfig = entry.config ?? {}
  rejectFallbackSrcInConfig(alias, rawConfig)
  const resolved = resolveForAlias(alias, entry.type || model.engine || model.addon, rawConfig)

  return {
    alias,
    modelSrc: model,
    sdkType: resolved.sdkType,
    endpointCategory: resolved.endpointCategory,
    isDefault: entry.default === true,
    preload: entry.preload !== false,
    ...modelFitPolicyOf(alias, entry.modelFitPolicy),
    ...fallbackSrcOf(alias, entry.fallbackSrc),
    config: resolveNestedModelSrcConstants(resolved.config, `serve.models.${alias}.config`)
  }
}

function parseExplicitEntry(alias: string, entry: ExplicitModelEntry): ResolvedModelEntry {
  if (!entry.type) {
    throw new Error(`serve.models.${alias}: "type" is required`)
  }

  const rawConfig = entry.config ?? {}
  rejectFallbackSrcInConfig(alias, rawConfig)
  const resolved = resolveForAlias(alias, entry.type, rawConfig)

  if (!entry.src) {
    throw new Error(`serve.models.${alias}: "src" is required`)
  }
  const src = entry.src

  // Allow `entry.src` to be either a path or a known SDK model-constant name.
  // Constant names look like `WAN2_1_T2V_1_3B_FP16`; paths contain `/` or
  // start with `.`. If the string is a registered constant, swap in the
  // ModelConstant object so the P2P registry resolves it.
  const modelSrc: string | ModelConstant = loadModelConstants().get(src) ?? src

  // fallbackSrc is an alternate source for a catalog model when the registry is
  // unreachable; a path or URL src has no registry download to fall back from.
  if (entry.fallbackSrc !== undefined && typeof modelSrc === 'string') {
    throw new Error(
      `serve.models.${alias}.fallbackSrc: only applies to a catalog model. ` +
        '"src" must be an SDK model constant name to use it.'
    )
  }

  return {
    alias,
    modelSrc,
    sdkType: resolved.sdkType,
    endpointCategory: resolved.endpointCategory,
    isDefault: entry.default === true,
    preload: entry.preload === true,
    ...modelFitPolicyOf(alias, entry.modelFitPolicy),
    ...fallbackSrcOf(alias, entry.fallbackSrc),
    config: resolveNestedModelSrcConstants(resolved.config, `serve.models.${alias}.config`)
  }
}

function modelFitPolicyOf(
  alias: string,
  value: string | undefined
): { modelFitPolicy?: ModelFitPolicy } {
  if (value === undefined) return {}
  const parsed = modelFitPolicySchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      `serve.models.${alias}.modelFitPolicy: expected one of ${modelFitPolicySchema.options
        .map((option) => `"${option}"`)
        .join(', ')}, got "${value}"`
    )
  }
  return { modelFitPolicy: parsed.data }
}

function fallbackSrcOf(alias: string, value: unknown): { fallbackSrc?: string } {
  if (value === undefined) return {}
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`serve.models.${alias}.fallbackSrc: expected an HTTP URL or a local file path`)
  }
  return { fallbackSrc: value }
}

// `config` is forwarded to the SDK as modelConfig, which rejects fallbackSrc as
// an unknown key. Point users at the entry-level field instead.
function rejectFallbackSrcInConfig(alias: string, config: Record<string, unknown>): void {
  if ('fallbackSrc' in config) {
    throw new Error(
      `serve.models.${alias}.config.fallbackSrc: fallbackSrc is a load option, not a model ` +
        `config field. Set serve.models.${alias}.fallbackSrc instead.`
    )
  }
}

export function resolveDefaults(models: Map<string, ResolvedModelEntry>): Map<string, string> {
  const defaults = new Map<string, string>()

  for (const [alias, entry] of models) {
    if (entry.isDefault) {
      defaults.set(entry.sdkType, alias)
    }
  }

  return defaults
}

export function resolveModelAlias(
  serveConfig: ServeConfig,
  modelName: string | null | undefined
): ResolvedModelEntry | null {
  if (!modelName) return null

  const entry = serveConfig.models.get(modelName)
  if (entry) return entry

  for (const [, e] of serveConfig.models) {
    if (srcOf(e.modelSrc) === modelName) return e
  }

  return null
}

function srcOf(modelSrc: string | ModelConstant): string {
  return typeof modelSrc === 'string' ? modelSrc : modelSrc.src
}
