const STATES = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  UNLOADING: 'unloading',
  ERROR: 'error'
} as const

export type ModelState = typeof STATES[keyof typeof STATES]

export interface ModelEntry {
  id: string
  src: string
  sdkType: string
  endpointCategory: string
  config: Record<string, unknown>
  state: ModelState
  createdAt: number
  error: string | null
  sdkModelId: string | null
}

export interface ServeConfig {
  models: Map<string, ResolvedModelEntry>
  defaults: Map<string, string>
  /**
   * Externally reachable origin for this server (e.g. "https://api.example.com").
   * Required to mint absolute URLs in image-generation responses when
   * `response_format=url`. Trailing slash is stripped on parse.
   */
  publicBaseUrl: string | null
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
  src: string
  sdkType: string
  endpointCategory: string
  isDefault: boolean
  preload: boolean
  config: Record<string, unknown>
}

export interface ModelRegistry {
  STATES: typeof STATES
  getEntry: (modelId: string) => ModelEntry | null
  getAll: () => ModelEntry[]
  getReady: () => ModelEntry[]
  register: (alias: string, opts: {
    src: string
    sdkType: string
    endpointCategory: string
    config: Record<string, unknown>
  }) => ModelEntry
  setLoading: (modelId: string) => void
  setReady: (modelId: string, sdkModelId?: string) => void
  setError: (modelId: string, error: unknown) => void
  remove: (modelId: string) => boolean
  isAllowed: (modelId: string, serveConfig: ServeConfig) => boolean
}

export function createModelRegistry (): ModelRegistry {
  const models = new Map<string, ModelEntry>()

  function getEntry (modelId: string): ModelEntry | null {
    return models.get(modelId) ?? null
  }

  function getAll (): ModelEntry[] {
    return Array.from(models.values())
  }

  function getReady (): ModelEntry[] {
    return getAll().filter((m) => m.state === STATES.READY)
  }

  function register (alias: string, opts: {
    src: string
    sdkType: string
    endpointCategory: string
    config: Record<string, unknown>
  }): ModelEntry {
    const existing = models.get(alias)
    if (existing) return existing

    const entry: ModelEntry = {
      id: alias,
      src: opts.src,
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

  function setLoading (modelId: string): void {
    const entry = models.get(modelId)
    if (entry) {
      entry.state = STATES.LOADING
      entry.error = null
    }
  }

  function setReady (modelId: string, sdkModelId?: string): void {
    const entry = models.get(modelId)
    if (entry) {
      entry.state = STATES.READY
      entry.error = null
      if (sdkModelId) entry.sdkModelId = sdkModelId
    }
  }

  function setError (modelId: string, error: unknown): void {
    const entry = models.get(modelId)
    if (entry) {
      entry.state = STATES.ERROR
      entry.error = error instanceof Error ? error.message : String(error)
    }
  }

  function remove (modelId: string): boolean {
    return models.delete(modelId)
  }

  function isAllowed (modelId: string, serveConfig: ServeConfig): boolean {
    if (serveConfig.models.size === 0) return true
    return serveConfig.models.has(modelId)
  }

  return {
    STATES,
    getEntry,
    getAll,
    getReady,
    register,
    setLoading,
    setReady,
    setError,
    remove,
    isAllowed
  }
}
