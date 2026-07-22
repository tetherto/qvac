import type OpenAI from 'openai'

export type StreamTimings = {
  requestStartS: number
  firstContentS: number | null
  lastContentS: number | null
  streamEndS: number | null
}

export type StreamParseResult = {
  content: string
  reasoningContent: string
  promptTokens: number | null
  completionTokens: number | null
  responseModel: string | null
  timings: StreamTimings
  error: string | null
}

export type RunMetrics = {
  ttftMs: number | null
  totalMs: number | null
  promptTokens: number | null
  completionTokens: number | null
  clientOutputTps: number | null
  effectivePrefillTps: number | null
}

export type ValidateRunParams = {
  parsed: StreamParseResult
  metrics: RunMetrics
  requireContent?: boolean
  checkReasoningOff?: boolean
}

export type ValidationResult = {
  ok: boolean
  reasons: string[]
}

export type MetricObservation = {
  value: number | null
  ok: boolean
}

export type AggregateStats = {
  median: number | null
  p25: number | null
  p75: number | null
  iqr: number | null
  nAttempted: number
  nValid: number
  nUnavailable: number
  nFailed: number
}

export type RawRunRecord = {
  provider: string
  prompt_id: string
  phase: string
  run_index: number
  run_id?: string
  started_at?: string
  ended_at?: string
  ok: boolean
  validation_reasons?: string[]
  response_model?: string | null
  content_preview?: string
  reasoning_preview?: string
  error?: string | null
  metrics: Record<string, number | null>
}

export type RawDocument = {
  session_id: string
  created_at: string
  valid?: boolean
  invalid_reasons?: string[]
  orchestration_errors?: Array<{ provider: string; message: string }>
  model_parity_evidence?: Record<string, unknown>
  config_snapshot: {
    generation: GenerationConfig
    cooldown_seconds?: number
    warmup_runs?: number
    measured_runs?: number
    prompt_ids: string[]
    providers: ProviderConfig[]
    model_parity: BenchmarkConfig['model_parity']
  }
  provider_order: string[]
  parity: Record<string, unknown>
  runs: RawRunRecord[]
}

export type GenerationConfig = {
  max_tokens?: number
  temperature?: number
  seed?: number | null
  stream?: boolean
  stream_options?: { include_usage?: boolean }
}

export type ProviderLifecycle = {
  start_command?: string[]
  stop_command?: string[]
  timeout_seconds?: number
}

export type ProviderConfig = {
  id: string
  base_url: string
  model: string
  lifecycle?: ProviderLifecycle
}

export type BenchmarkConfig = {
  session_dir?: string
  cooldown_seconds?: number
  warmup_runs?: number
  measured_runs?: number
  api_key?: string
  generation: GenerationConfig
  parity_prompt_id?: string
  prompt_ids: string[]
  providers: ProviderConfig[]
  model_parity: {
    registry_constant?: string
    gguf_filename?: string
    gguf_path: string
    sha256?: string
  }
}

export type PromptDoc = {
  id: string
  content: string
  target_prompt_tokens?: number
  meta?: Record<string, unknown>
}

export type PromptsFile = {
  parity: PromptDoc
  prompts: PromptDoc[]
}

export type ChatChunk = {
  model?: string | null
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null } | null
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      role?: string | null
    } | null
  }> | null
}

export type ChatClient = {
  chat: {
    completions: {
      create: (
        kwargs: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
      ) => Promise<AsyncIterable<ChatChunk> | Iterable<ChatChunk>>
    }
  }
}
