import type { ModelConstant } from '@qvac/sdk'

const STATES = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  UNLOADING: 'unloading',
  ERROR: 'error'
} as const

export type ModelState = (typeof STATES)[keyof typeof STATES]

export interface ModelEntry {
  id: string
  modelSrc: string | ModelConstant
  sdkType: string
  endpointCategory: string
  config: Record<string, unknown>
  state: ModelState
  createdAt: number
  error: string | null
  sdkModelId: string | null
}

export interface LoadConfig {
  /** When false, requests never trigger a load; an unloaded model returns
   * `503 model_not_loaded`. Only preloaded models serve. */
  lazy: boolean
  /** Max simultaneous lazy loads across distinct aliases (>= 1). */
  concurrency: number
  /** Per-load deadline in ms; `null` = unbounded. */
  timeoutMs: number | null
  /** When true, a client disconnect cancels the load it triggered (once no
   * other client is still waiting on the same load). */
  cancelOnDisconnect: boolean
}

export interface ServeConfig {
  models: Map<string, ResolvedModelEntry>
  defaults: Map<string, string>
  load: LoadConfig
  /**
   * Externally reachable origin for this server (e.g. "https://api.example.com").
   * Required to mint absolute URLs in image-generation responses when
   * `response_format=url`. Trailing slash is stripped on parse.
   */
  publicBaseUrl: string | null
  cors: {
    origins: string[]
  }
  openai: OpenAIServeOptions
}

export interface OpenAIServeOptions {
  audio: {
    speech: {
      defaultVoice: string | null
      /**
       * Maps an OpenAI `voice` string to a `serve.models` alias. Each alias can
       * carry its own TTS `config` (e.g. Chatterbox `referenceAudioSrc`, Supertonic
       * `ttsVoiceStyleSrc`). When set, this is tried before `${model}-${voice}` and
       * before the bare `model` alias. Keys are normalized to lowercase when parsed.
       */
      voices: Record<string, string> | null
      /**
       * Maximum allowed character length of `input`. Requests above this are
       * rejected with `400 input_too_long` before any synthesis runs (the
       * route otherwise buffers the full WAV in memory — DoS vector).
       * `null` disables the cap. Defaults to OpenAI's documented 4096.
       */
      maxInputChars: number | null
    }
  }
}

export interface ResolvedModelEntry {
  alias: string
  modelSrc: string | ModelConstant
  sdkType: string
  endpointCategory: string
  isDefault: boolean
  preload: boolean
  config: Record<string, unknown>
}

export interface ModelRegistry {
  STATES: typeof STATES
  getEntry: (modelId: string) => ModelEntry | null
  register: (
    alias: string,
    opts: {
      modelSrc: string | ModelConstant
      sdkType: string
      endpointCategory: string
      config: Record<string, unknown>
    }
  ) => ModelEntry
  setLoading: (modelId: string) => void
  setReady: (modelId: string, sdkModelId?: string) => void
  setError: (modelId: string, error: unknown) => void
  markUnloaded: (modelId: string) => void
}

export function createModelRegistry(): ModelRegistry {
  const models = new Map<string, ModelEntry>()

  function getEntry(modelId: string): ModelEntry | null {
    return models.get(modelId) ?? null
  }

  function register(
    alias: string,
    opts: {
      modelSrc: string | ModelConstant
      sdkType: string
      endpointCategory: string
      config: Record<string, unknown>
    }
  ): ModelEntry {
    const existing = models.get(alias)
    if (existing) return existing

    const entry: ModelEntry = {
      id: alias,
      modelSrc: opts.modelSrc,
      sdkType: opts.sdkType,
      endpointCategory: opts.endpointCategory,
      config: opts.config,
      state: STATES.IDLE,
      createdAt: Date.now(),
      error: null,
      sdkModelId: null
    }
    models.set(alias, entry)
    return entry
  }

  function setLoading(modelId: string): void {
    const entry = models.get(modelId)
    if (entry) {
      entry.state = STATES.LOADING
      entry.error = null
    }
  }

  function setReady(modelId: string, sdkModelId?: string): void {
    const entry = models.get(modelId)
    if (entry) {
      entry.state = STATES.READY
      entry.error = null
      if (sdkModelId) entry.sdkModelId = sdkModelId
    }
  }

  function setError(modelId: string, error: unknown): void {
    const entry = models.get(modelId)
    if (entry) {
      entry.state = STATES.ERROR
      entry.error = error instanceof Error ? error.message : String(error)
    }
  }

  // Reverse of a load: keep the alias registered so it can lazy-reload, but drop
  // the SDK handle and return it to IDLE. Used by unload so DELETE stays
  // reversible (the entry must survive for the next request to reload it).
  function markUnloaded(modelId: string): void {
    const entry = models.get(modelId)
    if (entry) {
      entry.state = STATES.IDLE
      entry.error = null
      entry.sdkModelId = null
    }
  }

  return {
    STATES,
    getEntry,
    register,
    setLoading,
    setReady,
    setError,
    markUnloaded
  }
}
