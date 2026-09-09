import type { ModelConstant } from '@qvac/sdk'

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
  /** Parsed `serve.<extension>` blocks, keyed by extension name. */
  extensions: Partial<ServeExtensionConfig>
}

/** Augmented by each extension with its own `serve.<name>` shape. */
// lunte-disable-next-line no-empty-interface
export interface ServeExtensionConfig {}

export interface ResolvedModelEntry {
  alias: string
  modelSrc: string | ModelConstant
  sdkType: string
  endpointCategory: string
  isDefault: boolean
  preload: boolean
  config: Record<string, unknown>
}
