import type { ModelConstant } from '@qvac/sdk'
import type { ServeConfig, ResolvedModelEntry, LoadConfig } from '@/serve/core/model-registry'
import { SDCPP_VIDEO_TYPE, resolveSdcppVideoAlias } from '@/serve/aliases/sdcpp-video'
import { normalizeCorsOrigin } from '@/serve/cors'
import { resolveNestedModelSrcConstants } from '@/serve/resolve-nested-model-src'
import { loadModelConstants } from '@/serve/sdk-constants'

const ENDPOINT_CATEGORY: Record<string, string> = {
  llm: 'chat',
  'llamacpp-completion': 'chat',
  embeddings: 'embedding',
  embedding: 'embedding',
  'llamacpp-embedding': 'embedding',
  whisper: 'transcription',
  'whispercpp-transcription': 'transcription',
  'whispercpp-audio-translation': 'audio-translation',
  parakeet: 'transcription',
  'parakeet-transcription': 'transcription',
  nmt: 'translation',
  'nmtcpp-translation': 'translation',
  tts: 'speech',
  'tts-ggml': 'speech',
  'onnx-tts': 'speech',
  ocr: 'ocr',
  'ggml-ocr': 'ocr',
  // Legacy model type from the ONNX era — route to the OCR endpoint so the
  // SDK's migration error surfaces instead of a category-less 400.
  'onnx-ocr': 'ocr',
  diffusion: 'image',
  'sdcpp-generation': 'image'
}

interface RawServeConfig {
  serve?: {
    models?: Record<string, string | ConstantModelEntry | ExplicitModelEntry>
    publicBaseUrl?: string
    cors?: {
      origins?: unknown
    }
    load?: RawLoadConfig
    openai?: RawOpenAIOptions
  }
}

interface RawLoadConfig {
  lazy?: unknown
  concurrency?: unknown
  timeoutMs?: unknown
  cancelOnDisconnect?: unknown
}

interface RawOpenAIOptions {
  audio?: {
    speech?: {
      defaultVoice?: unknown
      /** Map OpenAI `voice` -> `serve.models` alias (see ServeConfig.openai.audio.speech.voices). */
      voices?: unknown
      /** Cap on `input` length; `null` disables. See ServeConfig.openai.audio.speech.maxInputChars. */
      maxInputChars?: unknown
    }
  }
}

interface ConstantModelEntry {
  model: string
  type?: string
  default?: boolean
  preload?: boolean
  config?: Record<string, unknown>
}

interface ExplicitModelEntry {
  src: string
  type: string
  default?: boolean
  preload?: boolean
  config?: Record<string, unknown>
}

interface CLIServeOptions {
  model?: string | string[] | undefined
  publicBaseUrl?: string | undefined
  corsOrigins?: string[] | undefined
  lazyLoad?: boolean | undefined
  loadConcurrency?: number | undefined
  loadTimeoutMs?: number | null | undefined
  cancelLoadOnDisconnect?: boolean | undefined
}

export function parseServeConfig(
  rawConfig: RawServeConfig,
  cliOptions: CLIServeOptions
): ServeConfig {
  const serve = rawConfig.serve ?? {}
  const rawModels = serve.models ?? {}

  const models = new Map<string, ResolvedModelEntry>()

  for (const [alias, entry] of Object.entries(rawModels)) {
    let resolved: ResolvedModelEntry
    if (typeof entry === 'string') {
      resolved = resolveModelConstant(alias, { model: entry })
    } else if (isConstantModelEntry(entry)) {
      resolved = resolveModelConstant(alias, entry)
    } else {
      resolved = parseExplicitEntry(alias, entry as ExplicitModelEntry)
    }

    models.set(alias, resolved)
  }

  if (cliOptions.model) {
    const cliModels = Array.isArray(cliOptions.model) ? cliOptions.model : [cliOptions.model]
    for (const alias of cliModels) {
      const entry = models.get(alias)
      if (entry) {
        entry.preload = true
      }
    }
  }

  const publicBaseUrl = normalizePublicBaseUrl(cliOptions.publicBaseUrl ?? serve.publicBaseUrl)
  const corsOrigins = parseCorsOrigins(serve.cors?.origins, cliOptions.corsOrigins)

  return {
    models,
    defaults: resolveDefaults(models),
    load: parseLoadConfig(serve.load, cliOptions),
    publicBaseUrl,
    cors: { origins: corsOrigins },
    openai: parseOpenAIOptions(serve.openai)
  }
}

const DEFAULT_LOAD_CONCURRENCY = 1

function parseLoadConfig(raw: RawLoadConfig | undefined, cli: CLIServeOptions): LoadConfig {
  const lazy = cli.lazyLoad ?? asBoolean(raw?.lazy, 'serve.load.lazy') ?? true
  const cancelOnDisconnect =
    cli.cancelLoadOnDisconnect ??
    asBoolean(raw?.cancelOnDisconnect, 'serve.load.cancelOnDisconnect') ??
    true

  const concurrency =
    asPositiveInt(cli.loadConcurrency, '--load-concurrency') ??
    asPositiveInt(raw?.concurrency, 'serve.load.concurrency') ??
    DEFAULT_LOAD_CONCURRENCY

  let timeoutMs: number | null
  if (cli.loadTimeoutMs !== undefined) {
    timeoutMs =
      cli.loadTimeoutMs === null
        ? null
        : (asPositiveInt(cli.loadTimeoutMs, '--load-timeout') ?? null)
  } else {
    timeoutMs = asPositiveInt(raw?.timeoutMs, 'serve.load.timeoutMs') ?? null
  }

  return { lazy, concurrency, timeoutMs, cancelOnDisconnect }
}

function asBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
  return value
}

function asPositiveInt(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer`)
  }
  return value
}

function parseCorsOrigins(configured: unknown, cliOrigins: string[] | undefined): string[] {
  if (configured !== undefined && !Array.isArray(configured)) {
    throw new Error('serve.cors.origins must be an array of HTTP(S) origins')
  }

  const origins = [...(configured ?? []), ...(cliOrigins ?? [])] as unknown[]
  const normalized = origins.map((origin, index) => {
    if (typeof origin !== 'string') {
      throw new Error(`serve.cors.origins[${index}] must be a string`)
    }
    return normalizeCorsOrigin(origin)
  })

  return [...new Set(normalized)]
}

function normalizePublicBaseUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`serve.publicBaseUrl must start with http:// or https:// (got "${trimmed}").`)
  }
  return trimmed.replace(/\/+$/, '')
}

const DEFAULT_SPEECH_VOICE = 'alloy'
// OpenAI's documented limit for /v1/audio/speech `input`. Keeps memory
// pressure bounded since we buffer the full WAV before responding.
const DEFAULT_MAX_INPUT_CHARS = 4096

function parseOpenAIOptions(raw: RawOpenAIOptions | undefined): {
  audio: {
    speech: {
      defaultVoice: string | null
      voices: Record<string, string> | null
      maxInputChars: number | null
    }
  }
} {
  const rawDefaultVoice = raw?.audio?.speech?.defaultVoice
  let defaultVoice: string | null = DEFAULT_SPEECH_VOICE

  if (rawDefaultVoice === null) {
    // Explicit null disables the fallback so callers must always send `voice`.
    defaultVoice = null
  } else if (typeof rawDefaultVoice === 'string') {
    const trimmed = rawDefaultVoice.trim()
    defaultVoice = trimmed.length > 0 ? trimmed : null
  } else if (rawDefaultVoice !== undefined) {
    throw new Error('serve.openai.audio.speech.defaultVoice must be a string or null')
  }

  const rawVoices = raw?.audio?.speech?.voices
  let voices: Record<string, string> | null = null
  if (rawVoices !== undefined && rawVoices !== null) {
    if (typeof rawVoices !== 'object' || Array.isArray(rawVoices)) {
      throw new Error(
        'serve.openai.audio.speech.voices must be a JSON object (voice -> model alias)'
      )
    }
    const out: Record<string, string> = {}
    for (const [key, val] of Object.entries(rawVoices as Record<string, unknown>)) {
      if (typeof val !== 'string' || !val.trim()) {
        throw new Error(
          `serve.openai.audio.speech.voices["${key}"] must be a non-empty string (model alias)`
        )
      }
      const k = key.trim().toLowerCase()
      if (!k) continue
      out[k] = val.trim()
    }
    voices = Object.keys(out).length > 0 ? out : null
  }

  const rawMaxInput = raw?.audio?.speech?.maxInputChars
  let maxInputChars: number | null = DEFAULT_MAX_INPUT_CHARS
  if (rawMaxInput === null) {
    maxInputChars = null
  } else if (rawMaxInput !== undefined) {
    if (typeof rawMaxInput !== 'number' || !Number.isInteger(rawMaxInput) || rawMaxInput < 1) {
      throw new Error('serve.openai.audio.speech.maxInputChars must be a positive integer or null')
    }
    maxInputChars = rawMaxInput
  }

  return { audio: { speech: { defaultVoice, voices, maxInputChars } } }
}

export function normalizeEndpointCategory(sdkType: string): string {
  return ENDPOINT_CATEGORY[sdkType] ?? sdkType
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

function resolveDefaults(models: Map<string, ResolvedModelEntry>): Map<string, string> {
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
