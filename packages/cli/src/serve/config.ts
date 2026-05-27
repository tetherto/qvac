import { getSDK } from './core/sdk.js'
import type { ServeConfig, ResolvedModelEntry } from './core/model-registry.js'

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
  'onnx-ocr': 'ocr',
  diffusion: 'image',
  'sdcpp-generation': 'image'
}

interface RawServeConfig {
  serve?: {
    models?: Record<string, string | ConstantModelEntry | ExplicitModelEntry>
    publicBaseUrl?: string
    openai?: RawOpenAIOptions
  }
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
}

interface SDKModelConstant {
  src: string
  addon: string
  name: string
}

export async function parseServeConfig (rawConfig: RawServeConfig, cliOptions: CLIServeOptions): Promise<ServeConfig> {
  const serve = rawConfig.serve ?? {}
  const rawModels = serve.models ?? {}

  const models = new Map<string, ResolvedModelEntry>()
  const registry = await loadModelConstants()

  for (const [alias, entry] of Object.entries(rawModels)) {
    let resolved: ResolvedModelEntry
    if (typeof entry === 'string') {
      resolved = resolveModelConstant(alias, entry, registry)
    } else if (isConstantModelEntry(entry)) {
      resolved = resolveModelConstant(alias, entry.model, registry, entry)
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

  return {
    models,
    defaults: resolveDefaults(models),
    publicBaseUrl,
    openai: parseOpenAIOptions(serve.openai)
  }
}

function normalizePublicBaseUrl (raw: string | undefined): string | null {
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

function parseOpenAIOptions (raw: RawOpenAIOptions | undefined): {
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
      throw new Error('serve.openai.audio.speech.voices must be a JSON object (voice -> model alias)')
    }
    const out: Record<string, string> = {}
    for (const [key, val] of Object.entries(rawVoices as Record<string, unknown>)) {
      if (typeof val !== 'string' || !val.trim()) {
        throw new Error(`serve.openai.audio.speech.voices["${key}"] must be a non-empty string (model alias)`)
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

export function normalizeEndpointCategory (sdkType: string): string {
  return ENDPOINT_CATEGORY[sdkType] ?? sdkType
}

const VIRTUAL_SDK_WHISPER_AUDIO_TRANSLATION = 'whispercpp-audio-translation'

/**
 * Resolves explicit serve.models entries: maps the virtual whisper translation
 * alias to whispercpp-transcription + forces translate=true for SDK loadModel
 * (whisper modelConfig is flat whisper fields, not a nested whisperConfig object).
 * Exported for unit tests.
 */
export function resolveExplicitServeModel (type: string, config: Record<string, unknown>): {
  sdkType: string
  endpointCategory: string
  config: Record<string, unknown>
} {
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

function isConstantModelEntry (entry: unknown): entry is ConstantModelEntry {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    'model' in entry &&
    typeof (entry as Record<string, unknown>)['model'] === 'string'
  )
}

export function resolveModelConstant (alias: string, constantName: string, registry: Map<string, SDKModelConstant>, overrides?: ConstantModelEntry): ResolvedModelEntry {
  const model = registry.get(constantName)
  if (!model) {
    throw new Error(
      `serve.models.${alias}: unknown model constant "${constantName}". ` +
      'Use a valid SDK model name (e.g. QWEN3_600M_INST_Q4).'
    )
  }

  const rawConfig = overrides?.config ?? {}
  const resolved = overrides?.type
    ? resolveExplicitServeModel(overrides.type, rawConfig)
    : {
        sdkType: model.addon,
        endpointCategory: normalizeEndpointCategory(model.addon),
        config: rawConfig
      }

  return {
    alias,
    src: model.src,
    sdkType: resolved.sdkType,
    endpointCategory: resolved.endpointCategory,
    isDefault: overrides?.default === true,
    preload: overrides?.preload !== false,
    config: resolved.config
  }
}

function parseExplicitEntry (alias: string, entry: ExplicitModelEntry): ResolvedModelEntry {
  if (!entry.src) {
    throw new Error(`serve.models.${alias}: "src" is required`)
  }
  if (!entry.type) {
    throw new Error(`serve.models.${alias}: "type" is required`)
  }

  const rawConfig = entry.config ?? {}
  const resolved = resolveExplicitServeModel(entry.type, rawConfig)

  return {
    alias,
    src: entry.src,
    sdkType: resolved.sdkType,
    endpointCategory: resolved.endpointCategory,
    isDefault: entry.default === true,
    preload: entry.preload === true,
    config: resolved.config
  }
}

function resolveDefaults (models: Map<string, ResolvedModelEntry>): Map<string, string> {
  const defaults = new Map<string, string>()

  for (const [alias, entry] of models) {
    if (entry.isDefault) {
      defaults.set(entry.sdkType, alias)
    }
  }

  return defaults
}

export function resolveModelAlias (serveConfig: ServeConfig, modelName: string | null | undefined): ResolvedModelEntry | null {
  if (!modelName) return null

  const entry = serveConfig.models.get(modelName)
  if (entry) return entry

  for (const [, e] of serveConfig.models) {
    if (e.src === modelName) return e
  }

  return null
}

async function loadModelConstants (): Promise<Map<string, SDKModelConstant>> {
  const map = new Map<string, SDKModelConstant>()

  try {
    const sdk = await getSDK()
    for (const [key, value] of Object.entries(sdk)) {
      if (isSDKModelConstant(value)) {
        map.set(key, value)
        map.set(value.name, value)
      }
    }
  } catch {
    // SDK not available — only explicit entries will work
  }

  return map
}

function isSDKModelConstant (value: unknown): value is SDKModelConstant {
  return (
    value !== null &&
    typeof value === 'object' &&
    'src' in value &&
    'addon' in value &&
    'name' in value
  )
}
