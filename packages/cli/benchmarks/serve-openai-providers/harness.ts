import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import OpenAI from 'openai'
import { computeMetrics, validateRun } from './metrics.ts'
import { atomicWriteJson } from './persistence.ts'
import type {
  BenchmarkConfig,
  ChatChunk,
  ChatClient,
  GenerationConfig,
  PromptDoc,
  PromptsFile,
  RunMetrics,
  StreamParseResult,
  StreamTimings,
  ValidationResult
} from './types.ts'

export { configPlaceholders, loadBenchmarkConfig, PLACEHOLDER_PREFIXES } from './config.ts'
export { aggregateMetric, computeMetrics, validateRun } from './metrics.ts'
export { atomicWriteJson, sha256File, verifyModelParity } from './persistence.ts'
export { writeReport } from './report.ts'
export type { ModelParityEvidence } from './persistence.ts'
export type {
  AggregateStats,
  BenchmarkConfig,
  ChatChunk,
  ChatClient,
  GenerationConfig,
  MetricObservation,
  PromptDoc,
  PromptsFile,
  ProviderConfig,
  ProviderLifecycle,
  RawDocument,
  RunMetrics,
  StreamParseResult,
  StreamTimings,
  ValidateRunParams,
  ValidationResult
} from './types.ts'

export function nowSeconds(): number {
  return performance.now() / 1000
}

export function loadPrompts(path: string): PromptsFile {
  const data = JSON.parse(readFileSync(path, 'utf8')) as PromptsFile
  if (!data.parity || !Array.isArray(data.prompts)) {
    throw new Error('prompts.json must contain parity and prompts')
  }
  return data
}

export function promptById(promptsDoc: PromptsFile, promptId: string): PromptDoc {
  if (promptId === promptsDoc.parity.id) {
    return { ...promptsDoc.parity }
  }
  const found = promptsDoc.prompts.find((prompt) => prompt.id === promptId)
  if (!found) {
    throw new Error(`unknown prompt id: ${promptId}`)
  }
  return { ...found }
}

export function buildMessages(
  content: string,
  runId: string | null
): Array<{ role: 'user'; content: string }> {
  const body = runId ? `[run:${runId}] ${content}` : content
  return [{ role: 'user', content: body }]
}

export function buildCompletionKwargs(params: {
  model: string
  messages: Array<{ role: 'user'; content: string }>
  generation: GenerationConfig
}) {
  const kwargs: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: params.model,
    messages: params.messages,
    stream: true,
    temperature: params.generation.temperature ?? 0,
    max_tokens: params.generation.max_tokens ?? 128,
    stream_options: params.generation.stream_options ?? { include_usage: true }
  }
  if (params.generation.seed !== undefined && params.generation.seed !== null) {
    kwargs.seed = params.generation.seed
  }
  return kwargs
}

function deltaField(
  delta: { content?: string | null; reasoning_content?: string | null } | null | undefined,
  name: 'content' | 'reasoning_content'
): string {
  const value = delta?.[name]
  return typeof value === 'string' ? value : ''
}

export async function parseStream(
  chunks: AsyncIterable<ChatChunk> | Iterable<ChatChunk>,
  timings: StreamTimings,
  now: () => number = nowSeconds
): Promise<StreamParseResult> {
  const contentParts: string[] = []
  const reasoningParts: string[] = []
  let promptTokens: number | null = null
  let completionTokens: number | null = null
  let responseModel: string | null = null
  let error: string | null = null

  try {
    for await (const chunk of asAsyncIterable(chunks)) {
      if (chunk.model) {
        responseModel = chunk.model
      }
      if (chunk.usage) {
        if (chunk.usage.prompt_tokens != null) {
          promptTokens = Number(chunk.usage.prompt_tokens)
        }
        if (chunk.usage.completion_tokens != null) {
          completionTokens = Number(chunk.usage.completion_tokens)
        }
      }
      const choices = chunk.choices ?? []
      if (choices.length === 0) {
        continue
      }
      const delta = choices[0]?.delta
      if (!delta) {
        continue
      }
      const reasoning = deltaField(delta, 'reasoning_content')
      if (reasoning) {
        reasoningParts.push(reasoning)
      }
      const text = deltaField(delta, 'content')
      if (text) {
        const ts = now()
        if (timings.firstContentS === null) {
          timings.firstContentS = ts
        }
        timings.lastContentS = ts
        contentParts.push(text)
      }
    }
  } catch (err) {
    const name = err instanceof Error ? err.constructor.name : 'Error'
    const message = err instanceof Error ? err.message : String(err)
    error = `${name}: ${message}`
  }

  timings.streamEndS = now()
  return {
    content: contentParts.join(''),
    reasoningContent: reasoningParts.join(''),
    promptTokens,
    completionTokens,
    responseModel,
    timings,
    error
  }
}

async function* asAsyncIterable<T>(source: AsyncIterable<T> | Iterable<T>): AsyncGenerator<T> {
  const maybeAsync = source as AsyncIterable<T>
  if (typeof maybeAsync[Symbol.asyncIterator] === 'function') {
    for await (const item of maybeAsync) {
      yield item
    }
    return
  }
  for (const item of source as Iterable<T>) {
    yield item
  }
}

export function rotateIds(ids: string[], offset: number): string[] {
  if (ids.length === 0) {
    return []
  }
  const o = ((offset % ids.length) + ids.length) % ids.length
  return [...ids.slice(o), ...ids.slice(0, o)]
}

export function createSessionDir(base: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  const session = join(base, `session-${stamp}-${randomBytes(4).toString('hex')}`)
  mkdirSync(session, { recursive: false })
  return session
}

export function newRawDocument(
  config: BenchmarkConfig,
  sessionId: string
): Record<string, unknown> {
  return {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    config_snapshot: {
      generation: config.generation,
      cooldown_seconds: config.cooldown_seconds,
      warmup_runs: config.warmup_runs,
      measured_runs: config.measured_runs,
      prompt_ids: config.prompt_ids,
      providers: config.providers.map((p) => ({
        id: p.id,
        base_url: p.base_url,
        model: p.model
      })),
      model_parity: config.model_parity
    },
    provider_order: [] as string[],
    parity: {},
    runs: [] as unknown[]
  }
}

export function appendRun(
  rawPath: string,
  raw: Record<string, unknown>,
  run: Record<string, unknown>,
  write: (path: string, payload: unknown) => void = atomicWriteJson
): void {
  const runs = raw.runs as unknown[]
  runs.push(run)
  write(rawPath, raw)
}

export function makeClient(baseUrl: string, apiKey: string): OpenAI {
  return new OpenAI({ baseURL: baseUrl, apiKey })
}

export async function runStreamingCompletion(params: {
  client: ChatClient
  model: string
  messages: Array<{ role: 'user'; content: string }>
  generation: GenerationConfig
}): Promise<[StreamParseResult, RunMetrics, ValidationResult]> {
  const kwargs = buildCompletionKwargs(params)
  const timings: StreamTimings = {
    requestStartS: nowSeconds(),
    firstContentS: null,
    lastContentS: null,
    streamEndS: null
  }
  let parsed: StreamParseResult
  try {
    const stream = await params.client.chat.completions.create(kwargs)
    parsed = await parseStream(stream, timings)
  } catch (err) {
    timings.streamEndS = nowSeconds()
    const name = err instanceof Error ? err.constructor.name : 'Error'
    const message = err instanceof Error ? err.message : String(err)
    parsed = {
      content: '',
      reasoningContent: '',
      promptTokens: null,
      completionTokens: null,
      responseModel: null,
      timings,
      error: `${name}: ${message}`
    }
  }
  const metrics = computeMetrics(parsed)
  const validation = validateRun({ parsed, metrics })
  return [parsed, metrics, validation]
}

export function metricsToJson(metrics: RunMetrics): Record<string, unknown> {
  return {
    ttft_ms: metrics.ttftMs,
    total_ms: metrics.totalMs,
    prompt_tokens: metrics.promptTokens,
    completion_tokens: metrics.completionTokens,
    client_output_tps: metrics.clientOutputTps,
    effective_prefill_tps: metrics.effectivePrefillTps
  }
}

export function createFakeChunk(params: {
  content?: string | null
  reasoningContent?: string | null
  role?: string | null
  usage?: { promptTokens: number; completionTokens: number } | null
  model?: string | null
  emptyChoices?: boolean
}): ChatChunk {
  if (params.emptyChoices) {
    return {
      model: params.model ?? null,
      usage: params.usage
        ? {
            prompt_tokens: params.usage.promptTokens,
            completion_tokens: params.usage.completionTokens
          }
        : null,
      choices: []
    }
  }
  return {
    model: params.model ?? null,
    usage: params.usage
      ? {
          prompt_tokens: params.usage.promptTokens,
          completion_tokens: params.usage.completionTokens
        }
      : null,
    choices: [
      {
        delta: {
          content: params.content ?? null,
          reasoning_content: params.reasoningContent ?? null,
          role: params.role ?? null
        }
      }
    ]
  }
}
