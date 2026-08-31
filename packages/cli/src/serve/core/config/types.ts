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
