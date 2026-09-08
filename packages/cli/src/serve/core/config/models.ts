import type { ModelConstant } from '@qvac/sdk'
import type { ResolvedModelEntry, ServeConfig } from '@/serve/core/config/types'
import { SDCPP_VIDEO_TYPE, resolveSdcppVideoAlias } from '@/serve/core/config/aliases/sdcpp-video'
import { normalizeEndpointCategory } from '@/serve/core/config/endpoint-category'
import { loadModelConstants } from '@/serve/core/config/constants'
import { resolveNestedModelSrcConstants } from '@/serve/core/config/nested-model-src'

export interface ConstantModelEntry {
  model: string
  type?: string
  default?: boolean
  preload?: boolean
  config?: Record<string, unknown>
}

export interface ExplicitModelEntry {
  src: string
  type: string
  default?: boolean
  preload?: boolean
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
      endpointCategory: normalizeEndpointCategory(type),
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
  const resolved = entry.type
    ? resolveExplicitServeModel(entry.type, rawConfig)
    : {
        sdkType: model.addon,
        endpointCategory: normalizeEndpointCategory(model.addon),
        config: rawConfig
      }

  return {
    alias,
    modelSrc: model,
    sdkType: resolved.sdkType,
    endpointCategory: resolved.endpointCategory,
    isDefault: entry.default === true,
    preload: entry.preload !== false,
    config: resolveNestedModelSrcConstants(resolved.config, `serve.models.${alias}.config`)
  }
}

function parseExplicitEntry(alias: string, entry: ExplicitModelEntry): ResolvedModelEntry {
  if (!entry.src) {
    throw new Error(`serve.models.${alias}: "src" is required`)
  }
  if (!entry.type) {
    throw new Error(`serve.models.${alias}: "type" is required`)
  }

  const rawConfig = entry.config ?? {}
  const resolved = resolveExplicitServeModel(entry.type, rawConfig)

  // Allow `entry.src` to be either a path or a known SDK model-constant name.
  // Constant names look like `WAN2_1_T2V_1_3B_FP16`; paths contain `/` or
  // start with `.`. If the string is a registered constant, swap in the
  // ModelConstant object so the P2P registry resolves it.
  const modelSrc: string | ModelConstant = loadModelConstants().get(entry.src) ?? entry.src

  return {
    alias,
    modelSrc,
    sdkType: resolved.sdkType,
    endpointCategory: resolved.endpointCategory,
    isDefault: entry.default === true,
    preload: entry.preload === true,
    config: resolveNestedModelSrcConstants(resolved.config, `serve.models.${alias}.config`)
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
