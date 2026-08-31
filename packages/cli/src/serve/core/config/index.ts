import type { LoadConfig, OpenAIServeOptions, ServeConfig } from '@/serve/core/config/types'
import { resolveDefaults, resolveServeModels, type RawModelEntry } from '@/serve/core/config/models'
import { normalizeCorsOrigin } from '@/serve/cors'

interface RawServeConfig {
  serve?: {
    models?: Record<string, RawModelEntry>
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
  const models = resolveServeModels(serve.models ?? {})

  if (cliOptions.model) {
    const cliModels = Array.isArray(cliOptions.model) ? cliOptions.model : [cliOptions.model]
    for (const alias of cliModels) {
      const entry = models.get(alias)
      if (entry) {
        entry.preload = true
      }
    }
  }

  return {
    models,
    defaults: resolveDefaults(models),
    load: parseLoadConfig(serve.load, cliOptions),
    publicBaseUrl: normalizePublicBaseUrl(cliOptions.publicBaseUrl ?? serve.publicBaseUrl),
    cors: { origins: parseCorsOrigins(serve.cors?.origins, cliOptions.corsOrigins) },
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

function parseOpenAIOptions(raw: RawOpenAIOptions | undefined): OpenAIServeOptions {
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
