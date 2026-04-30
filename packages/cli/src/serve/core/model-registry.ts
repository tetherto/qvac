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
