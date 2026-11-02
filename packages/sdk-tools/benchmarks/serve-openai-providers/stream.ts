import OpenAI from 'openai'
import { computeMetrics, validateRun } from './metrics'
import type {
  ChatChunk,
  ChatClient,
  GenerationConfig,
  RunMetrics,
  StreamParseResult,
  StreamTimings,
  ValidationResult
} from './types'

export function nowSeconds(): number {
  return performance.now() / 1000
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
        if (chunk.usage.prompt_tokens !== null && chunk.usage.prompt_tokens !== undefined) {
          promptTokens = Number(chunk.usage.prompt_tokens)
        }
        if (chunk.usage.completion_tokens !== null && chunk.usage.completion_tokens !== undefined) {
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
        const timestamp = now()
        if (timings.firstContentS === null) {
          timings.firstContentS = timestamp
        }
        timings.lastContentS = timestamp
        contentParts.push(text)
      }
    }
  } catch (caught) {
    const name = caught instanceof Error ? caught.constructor.name : 'Error'
    const message = caught instanceof Error ? caught.message : String(caught)
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

export function makeClient(baseUrl: string, apiKey: string): OpenAI {
  return new OpenAI({ baseURL: baseUrl, apiKey })
}

export async function runStreamingCompletion(params: {
  client: ChatClient
  model: string
  messages: Array<{ role: 'user'; content: string }>
  generation: GenerationConfig
  now?: () => number
}): Promise<[StreamParseResult, RunMetrics, ValidationResult]> {
  const now = params.now ?? nowSeconds
  const kwargs = buildCompletionKwargs(params)
  const timings: StreamTimings = {
    requestStartS: now(),
    firstContentS: null,
    lastContentS: null,
    streamEndS: null
  }
  let parsed: StreamParseResult
  try {
    const stream = await params.client.chat.completions.create(kwargs)
    parsed = await parseStream(stream, timings, now)
  } catch (caught) {
    timings.streamEndS = now()
    const name = caught instanceof Error ? caught.constructor.name : 'Error'
    const message = caught instanceof Error ? caught.message : String(caught)
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
