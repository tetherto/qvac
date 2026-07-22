import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import OpenAI from 'openai'
import { computeMetrics, validateRun } from './metrics.ts'
import { writeReport } from './report.ts'
import type {
  BenchmarkConfig,
  ChatChunk,
  GenerationConfig,
  PromptDoc,
  PromptsFile,
  ProviderConfig,
  RawDocument,
  RunMetrics,
  StreamParseResult,
  StreamTimings,
  ValidationResult
} from './types.ts'

export const PLACEHOLDER_PREFIXES = ['REPLACE_WITH_'] as const

export { aggregateMetric, computeMetrics, validateRun } from './metrics.ts'
export { writeReport } from './report.ts'
export type {
  AggregateStats,
  BenchmarkConfig,
  ChatChunk,
  GenerationConfig,
  MetricObservation,
  PromptDoc,
  PromptsFile,
  ProviderConfig,
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

export function loadBenchmarkConfig(path: string): BenchmarkConfig {
  const data = loadYaml(readFileSync(path, 'utf8'))
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`config must be a mapping: ${path}`)
  }
  return data as BenchmarkConfig
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

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

export function atomicWriteJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const dir = dirname(path)
  const tmpDir = mkdtempSync(join(dir, '.tmp-'))
  const tmpPath = join(tmpDir, 'payload.json')
  try {
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, path)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
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
  run: Record<string, unknown>
): void {
  const runs = raw.runs as unknown[]
  runs.push(run)
  atomicWriteJson(rawPath, raw)
}

export function makeClient(baseUrl: string, apiKey: string): OpenAI {
  return new OpenAI({ baseURL: baseUrl, apiKey })
}

export async function runStreamingCompletion(params: {
  client: OpenAI
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
    parsed = await parseStream(stream as AsyncIterable<ChatChunk>, timings)
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

export function configPlaceholders(config: BenchmarkConfig): string[] {
  const bad: string[] = []
  for (const provider of config.providers) {
    for (const key of ['model', 'base_url'] as const) {
      const value = String(provider[key] ?? '')
      if (PLACEHOLDER_PREFIXES.some((prefix) => value.startsWith(prefix))) {
        bad.push(`providers.${provider.id}.${key}`)
      }
    }
  }
  const gguf = String(config.model_parity.gguf_path ?? '')
  if (!gguf || PLACEHOLDER_PREFIXES.some((prefix) => gguf.startsWith(prefix))) {
    bad.push('model_parity.gguf_path')
  }
  return bad
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

export async function cmdDigest(config: BenchmarkConfig): Promise<number> {
  const path = resolve(config.model_parity.gguf_path.replace(/^~/, process.env.HOME ?? ''))
  try {
    const st = statSync(path)
    if (!st.isFile()) {
      console.error(`GGUF not found: ${path}`)
      return 1
    }
    const digest = await sha256File(path)
    console.log(JSON.stringify({ path, bytes: st.size, sha256: digest }, null, 2))
    return 0
  } catch {
    console.error(`GGUF not found: ${path}`)
    return 1
  }
}

export async function cmdPreflight(
  config: BenchmarkConfig,
  promptsDoc: PromptsFile,
  sessionDir?: string
): Promise<number> {
  const bad = configPlaceholders(config)
  if (bad.length > 0) {
    console.error('Replace placeholders before preflight:')
    for (const item of bad) {
      console.error(`  - ${item}`)
    }
    return 1
  }

  const parity = promptById(promptsDoc, config.parity_prompt_id ?? 'parity')
  const generation = config.generation
  const apiKey = config.api_key ?? 'local-benchmark-key'
  const results: Record<string, unknown> = {}
  const promptTokenCounts: Record<string, number> = {}

  for (const provider of config.providers) {
    const client = makeClient(provider.base_url, apiKey)
    const messages = buildMessages(parity.content, null)
    const [parsed, metrics, validation] = await runStreamingCompletion({
      client,
      model: provider.model,
      messages,
      generation
    })
    results[provider.id] = {
      ok: validation.ok,
      reasons: validation.reasons,
      prompt_tokens: parsed.promptTokens,
      completion_tokens: parsed.completionTokens,
      response_model: parsed.responseModel,
      content: parsed.content,
      metrics: metricsToJson(metrics)
    }
    if (parsed.promptTokens !== null) {
      promptTokenCounts[provider.id] = parsed.promptTokens
    }
    const status = validation.ok ? 'OK' : 'FAIL'
    console.log(
      `[${status}] ${provider.id}: reasons=${JSON.stringify(validation.reasons)} usage=(${parsed.promptTokens},${parsed.completionTokens})`
    )
  }

  const unique = new Set(Object.values(promptTokenCounts))
  const parityOk =
    unique.size === 1 && Object.keys(promptTokenCounts).length === config.providers.length
  if (!parityOk) {
    console.error(
      `FAIL prompt_tokens parity across providers: ${JSON.stringify(promptTokenCounts)}`
    )
  } else {
    console.log(`OK prompt_tokens parity: ${[...unique][0]}`)
  }

  if (sessionDir) {
    const rawPath = join(sessionDir, 'raw.json')
    const raw = newRawDocument(config, sessionDir.split(/[\\/]/).pop() ?? sessionDir)
    raw.parity = { results, prompt_tokens_equal: parityOk }
    atomicWriteJson(rawPath, raw)
  }

  const allOk = parityOk && Object.values(results).every((v) => (v as { ok: boolean }).ok)
  return allOk ? 0 : 1
}

export async function runOne(params: {
  client: OpenAI
  provider: ProviderConfig
  prompt: PromptDoc
  generation: GenerationConfig
  phase: string
  runIndex: number
}): Promise<Record<string, unknown>> {
  const runId = randomBytes(5).toString('hex')
  const messages = buildMessages(params.prompt.content, runId)
  const startedAt = new Date().toISOString()
  const [parsed, metrics, validation] = await runStreamingCompletion({
    client: params.client,
    model: params.provider.model,
    messages,
    generation: params.generation
  })
  const endedAt = new Date().toISOString()
  return {
    provider: params.provider.id,
    prompt_id: params.prompt.id,
    phase: params.phase,
    run_index: params.runIndex,
    run_id: runId,
    started_at: startedAt,
    ended_at: endedAt,
    ok: validation.ok,
    validation_reasons: validation.reasons,
    response_model: parsed.responseModel,
    content_preview: parsed.content.slice(0, 240),
    reasoning_preview: parsed.reasoningContent.slice(0, 240),
    error: parsed.error,
    metrics: metricsToJson(metrics)
  }
}

export async function cmdSmoke(config: BenchmarkConfig, promptsDoc: PromptsFile): Promise<number> {
  const pre = await cmdPreflight(config, promptsDoc)
  if (pre !== 0) {
    return pre
  }
  const shortest = config.prompt_ids[0]!
  const prompt = promptById(promptsDoc, shortest)
  const apiKey = config.api_key ?? 'local-benchmark-key'
  let failed = false
  for (const provider of config.providers) {
    const client = makeClient(provider.base_url, apiKey)
    const result = await runOne({
      client,
      provider,
      prompt,
      generation: config.generation,
      phase: 'smoke',
      runIndex: 0
    })
    const metrics = result.metrics as Record<string, unknown>
    const status = result.ok ? 'OK' : 'FAIL'
    console.log(
      `[${status}] smoke ${provider.id} ${shortest}: ttft_ms=${metrics.ttft_ms} client_output_tps=${metrics.client_output_tps} reasons=${JSON.stringify(result.validation_reasons)}`
    )
    if (!result.ok) {
      failed = true
    }
  }
  return failed ? 1 : 0
}

export async function cmdCalibrate(
  config: BenchmarkConfig,
  promptsDoc: PromptsFile,
  providerId: string
): Promise<number> {
  const provider = config.providers.find((p) => p.id === providerId)
  if (!provider) {
    console.error(`unknown provider: ${providerId}`)
    return 1
  }
  if (PLACEHOLDER_PREFIXES.some((prefix) => provider.model.startsWith(prefix))) {
    console.error(`set providers.${providerId}.model first`)
    return 1
  }
  const client = makeClient(provider.base_url, config.api_key ?? 'local-benchmark-key')
  const generation: GenerationConfig = {
    ...config.generation,
    max_tokens: Math.min(config.generation.max_tokens ?? 128, 16)
  }
  const rows: Array<Record<string, unknown>> = []
  for (const promptId of config.prompt_ids) {
    const prompt = promptById(promptsDoc, promptId)
    const [parsed, , validation] = await runStreamingCompletion({
      client,
      model: provider.model,
      messages: buildMessages(prompt.content, 'calibrate'),
      generation
    })
    const row = {
      prompt_id: promptId,
      target_prompt_tokens: prompt.target_prompt_tokens,
      measured_prompt_tokens: parsed.promptTokens,
      ok: validation.ok,
      reasons: validation.reasons
    }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
  return rows.every((r) => r.ok && r.measured_prompt_tokens) ? 0 : 1
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export async function cmdFull(
  config: BenchmarkConfig,
  promptsDoc: PromptsFile,
  root: string
): Promise<number> {
  const sessionBase = join(root, config.session_dir ?? 'results')
  mkdirSync(sessionBase, { recursive: true })
  const sessionDir = createSessionDir(sessionBase)
  const rawPath = join(sessionDir, 'raw.json')
  let raw = newRawDocument(config, sessionDir.split(/[\\/]/).pop() ?? sessionDir)
  atomicWriteJson(rawPath, raw)

  console.log(`session: ${sessionDir}`)
  if ((await cmdPreflight(config, promptsDoc, sessionDir)) !== 0) {
    console.error('preflight failed; aborting full sweep')
    return 1
  }

  raw = JSON.parse(readFileSync(rawPath, 'utf8')) as Record<string, unknown>
  const apiKey = config.api_key ?? 'local-benchmark-key'
  const warmupRuns = config.warmup_runs ?? 1
  const measuredRuns = config.measured_runs ?? 5
  const cooldownSeconds = config.cooldown_seconds ?? 90
  const basePromptIds = [...config.prompt_ids]

  for (let providerIndex = 0; providerIndex < config.providers.length; providerIndex += 1) {
    const provider = config.providers[providerIndex]!
    ;(raw.provider_order as string[]).push(provider.id)
    atomicWriteJson(rawPath, raw)
    console.log(`\n=== provider ${provider.id} ===`)
    const client = makeClient(provider.base_url, apiKey)
    const order = rotateIds(basePromptIds, providerIndex)
    console.log(`prompt order: ${JSON.stringify(order)}`)

    for (const promptId of order) {
      const prompt = promptById(promptsDoc, promptId)
      for (let i = 0; i < warmupRuns; i += 1) {
        const run = await runOne({
          client,
          provider,
          prompt,
          generation: config.generation,
          phase: 'warmup',
          runIndex: i
        })
        appendRun(rawPath, raw, run)
        console.log(`warmup ${provider.id} ${promptId}#${i} ok=${run.ok}`)
      }
      for (let i = 0; i < measuredRuns; i += 1) {
        const run = await runOne({
          client,
          provider,
          prompt,
          generation: config.generation,
          phase: 'measured',
          runIndex: i
        })
        appendRun(rawPath, raw, run)
        const m = run.metrics as Record<string, unknown>
        console.log(
          `measured ${provider.id} ${promptId}#${i} ok=${run.ok} ttft_ms=${m.ttft_ms} client_output_tps=${m.client_output_tps}`
        )
      }
    }

    if (providerIndex < config.providers.length - 1 && cooldownSeconds > 0) {
      console.log(`cooldown ${cooldownSeconds}s before next provider`)
      await sleep(cooldownSeconds * 1000)
    }
  }

  const reportPath = join(sessionDir, 'report.md')
  writeReport(raw as RawDocument, reportPath)
  atomicWriteJson(join(sessionBase, 'raw.json'), raw)
  copyFileSync(reportPath, join(sessionBase, 'report.md'))
  console.log(`wrote ${reportPath}`)
  console.log(`copied ${join(sessionBase, 'raw.json')} and ${join(sessionBase, 'report.md')}`)

  const measuredFailures = ((raw.runs as Array<Record<string, unknown>>) ?? []).filter(
    (r) => r.phase === 'measured' && !r.ok
  )
  if (measuredFailures.length > 0) {
    console.error(`FAIL: ${measuredFailures.length} measured run(s) failed; see ${rawPath}`)
    return 1
  }
  return 0
}

export async function cmdReport(rawPath: string, reportPath: string): Promise<number> {
  const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as RawDocument
  writeReport(raw, reportPath)
  console.log(`wrote ${reportPath}`)
  return 0
}
