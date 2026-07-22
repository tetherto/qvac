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

export const THINK_MARKERS = ['<think>', '</think>'] as const
export const PLACEHOLDER_PREFIXES = ['REPLACE_WITH_'] as const

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
  decodeWindowMs: number | null
  promptTokens: number | null
  completionTokens: number | null
  decodeTps: number | null
  effectivePrefillTps: number | null
  decodeTpsUnavailableReason: string | null
}

export type ValidationResult = {
  ok: boolean
  reasons: string[]
}

export type AggregateStats = {
  median: number | null
  p25: number | null
  p75: number | null
  iqr: number | null
  nValid: number
  nFailed: number
}

export type GenerationConfig = {
  max_tokens?: number
  temperature?: number
  seed?: number | null
  stream?: boolean
  stream_options?: { include_usage?: boolean }
}

export type ProviderConfig = {
  id: string
  base_url: string
  model: string
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
}): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {
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

export function computeMetrics(parsed: StreamParseResult): RunMetrics {
  const t = parsed.timings
  let ttftMs: number | null = null
  let totalMs: number | null = null
  let decodeWindowMs: number | null = null

  if (t.firstContentS !== null) {
    ttftMs = (t.firstContentS - t.requestStartS) * 1000
  }
  if (t.streamEndS !== null) {
    totalMs = (t.streamEndS - t.requestStartS) * 1000
  }
  if (t.firstContentS !== null && t.lastContentS !== null) {
    decodeWindowMs = (t.lastContentS - t.firstContentS) * 1000
  }

  let decodeTps: number | null = null
  let decodeReason: string | null = null
  if (parsed.completionTokens === null) {
    decodeReason = 'missing_completion_tokens'
  } else if (parsed.completionTokens < 2) {
    decodeReason = 'completion_tokens_lt_2'
  } else if (decodeWindowMs === null || decodeWindowMs <= 0) {
    decodeReason = 'decode_window_zero_or_missing'
  } else {
    decodeTps = (parsed.completionTokens - 1) / (decodeWindowMs / 1000)
  }

  let effectivePrefillTps: number | null = null
  if (parsed.promptTokens !== null && parsed.promptTokens > 0 && ttftMs !== null && ttftMs > 0) {
    effectivePrefillTps = parsed.promptTokens / (ttftMs / 1000)
  }

  return {
    ttftMs,
    totalMs,
    decodeWindowMs,
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    decodeTps,
    effectivePrefillTps,
    decodeTpsUnavailableReason: decodeReason
  }
}

export function validateRun(params: {
  parsed: StreamParseResult
  metrics: RunMetrics
  requireContent?: boolean
  checkReasoningOff?: boolean
}): ValidationResult {
  const requireContent = params.requireContent ?? true
  const checkReasoningOff = params.checkReasoningOff ?? true
  const reasons: string[] = []
  const { parsed, metrics } = params

  if (parsed.error) {
    reasons.push(`stream_error:${parsed.error}`)
  }
  if (requireContent && !parsed.content.trim()) {
    reasons.push('empty_content')
  }
  if (parsed.promptTokens === null || parsed.completionTokens === null) {
    reasons.push('missing_usage')
  } else {
    if (parsed.promptTokens <= 0) {
      reasons.push('prompt_tokens_zero')
    }
    if (parsed.completionTokens <= 0) {
      reasons.push('completion_tokens_zero')
    }
  }
  if (metrics.ttftMs === null) {
    reasons.push('missing_ttft')
  }
  if (metrics.totalMs === null) {
    reasons.push('missing_total')
  }
  if (checkReasoningOff) {
    const lowered = parsed.content.toLowerCase()
    for (const marker of THINK_MARKERS) {
      if (lowered.includes(marker)) {
        reasons.push(`think_marker_in_content:${marker}`)
        break
      }
    }
    if (parsed.reasoningContent.trim()) {
      reasons.push('reasoning_content_non_empty')
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/** Match Python statistics.quantiles(..., n=4, method='inclusive'). */
export function quantilesInclusive(values: number[]): [number, number, number] {
  if (values.length === 0) {
    throw new Error('values must be non-empty')
  }
  if (values.length === 1) {
    const v = values[0]!
    return [v, v, v]
  }
  const data = [...values].sort((a, b) => a - b)
  const n = 4
  const m = data.length - 1
  const result: number[] = []
  for (let i = 1; i < n; i += 1) {
    const product = i * m
    const j = Math.floor(product / n)
    const delta = product % n
    const left = data[j]!
    const right = data[j + 1]!
    result.push((left * (n - delta) + right * delta) / n)
  }
  return [result[0]!, result[1]!, result[2]!]
}

export function aggregateMetric(
  values: Array<number | null | undefined>,
  nFailed: number
): AggregateStats {
  const clean = values.filter((v): v is number => v != null).map((v) => Number(v))
  if (clean.length === 0) {
    return { median: null, p25: null, p75: null, iqr: null, nValid: 0, nFailed }
  }
  const [p25, median, p75] = quantilesInclusive(clean)
  return {
    median,
    p25,
    p75,
    iqr: p75 - p25,
    nValid: clean.length,
    nFailed
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
    const stream = await params.client.chat.completions.create(
      kwargs as Parameters<OpenAI['chat']['completions']['create']>[0]
    )
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
    decode_window_ms: metrics.decodeWindowMs,
    prompt_tokens: metrics.promptTokens,
    completion_tokens: metrics.completionTokens,
    decode_tps: metrics.decodeTps,
    effective_prefill_tps: metrics.effectivePrefillTps,
    decode_tps_unavailable_reason: metrics.decodeTpsUnavailableReason
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
      `[${status}] smoke ${provider.id} ${shortest}: ttft_ms=${metrics.ttft_ms} decode_tps=${metrics.decode_tps} reasons=${JSON.stringify(result.validation_reasons)}`
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

function fmt(value: number | null, digits = 2): string {
  if (value === null) {
    return '—'
  }
  return value.toFixed(digits)
}

export function writeReport(raw: Record<string, unknown>, path: string): void {
  const snapshot = (raw.config_snapshot ?? {}) as Record<string, unknown>
  const providers = ((snapshot.providers as ProviderConfig[]) ?? []).map((p) => p.id)
  const promptIds = (snapshot.prompt_ids as string[]) ?? []
  const measured = ((raw.runs as Array<Record<string, unknown>>) ?? []).filter(
    (r) => r.phase === 'measured'
  )

  const lines: string[] = []
  lines.push('# OpenAI Server Performance Benchmark Report')
  lines.push('')
  lines.push(`Session: \`${raw.session_id}\``)
  lines.push(`Created: \`${raw.created_at}\``)
  lines.push('')
  lines.push('## Executive summary')
  lines.push('')
  lines.push(
    'Client-side comparison of OpenAI-compatible `/v1/chat/completions` across qvac serve, Ollama, and LM Studio using one shared GGUF and one shared SDK path.'
  )
  lines.push('')
  lines.push('## Environment and exact revisions')
  lines.push('')
  lines.push('See `environment.md` in the harness directory for host, package, and launch details.')
  lines.push('')
  lines.push('## Model parity evidence')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(snapshot.model_parity ?? {}, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('Preflight parity:')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(raw.parity ?? {}, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('## Methodology and metric definitions')
  lines.push('')
  lines.push('- TTFT: request start → first non-empty `delta.content`')
  lines.push('- Total: request start → stream completion')
  lines.push('- Decode TPS: `(completion_tokens - 1) / decode_window_s`')
  lines.push(
    '- Effective prefill TPS (proxy): `prompt_tokens / ttft_s` (includes HTTP, queueing, template, prefill, first token; not native ppTPS)'
  )
  lines.push(`- Provider order: ${JSON.stringify(raw.provider_order)}`)
  lines.push(`- Cool-down between providers: ${snapshot.cooldown_seconds}s`)
  lines.push('')

  const metricKeys: Array<[string, string]> = [
    ['ttft_ms', 'TTFT (ms)'],
    ['total_ms', 'Total latency (ms)'],
    ['decode_tps', 'Decode TPS']
  ]
  lines.push('## Median and IQR tables by prompt size')
  lines.push('')
  for (const [metricKey, title] of metricKeys) {
    lines.push(`### ${title}`)
    lines.push('')
    lines.push(`| Prompt | ${providers.join(' | ')} |`)
    lines.push(`|---| ${providers.map(() => '---').join(' | ')} |`)
    for (const promptId of promptIds) {
      const cells = [promptId]
      for (const provider of providers) {
        const values = measured
          .filter((r) => r.provider === provider && r.prompt_id === promptId && r.ok)
          .map((r) => (r.metrics as Record<string, number | null>)[metricKey] ?? null)
        const nFailed = measured.filter(
          (r) => r.provider === provider && r.prompt_id === promptId && !r.ok
        ).length
        const stats = aggregateMetric(values, nFailed)
        cells.push(
          `${fmt(stats.median)} (IQR ${fmt(stats.iqr)}; n=${stats.nValid}/${stats.nValid + stats.nFailed})`
        )
      }
      lines.push(`| ${cells.join(' | ')} |`)
    }
    lines.push('')
  }

  lines.push('## Effective prefill TPS (proxy)')
  lines.push('')
  lines.push('End-to-end proxy only. Do not interpret as native llama.cpp prefill throughput.')
  lines.push('')
  lines.push(`| Prompt | ${providers.join(' | ')} |`)
  lines.push(`|---| ${providers.map(() => '---').join(' | ')} |`)
  for (const promptId of promptIds) {
    const cells = [promptId]
    for (const provider of providers) {
      const values = measured
        .filter((r) => r.provider === provider && r.prompt_id === promptId && r.ok)
        .map((r) => (r.metrics as Record<string, number | null>).effective_prefill_tps ?? null)
      const nFailed = measured.filter(
        (r) => r.provider === provider && r.prompt_id === promptId && !r.ok
      ).length
      const stats = aggregateMetric(values, nFailed)
      cells.push(`${fmt(stats.median)} (IQR ${fmt(stats.iqr)})`)
    }
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('')

  lines.push('## Run variability and failures')
  lines.push('')
  const failures = measured.filter((r) => !r.ok)
  lines.push(`Measured failures: ${failures.length}`)
  lines.push('')
  if (failures.length === 0) {
    lines.push('- None')
  } else {
    for (const fail of failures) {
      lines.push(
        `- \`${fail.provider}\` \`${fail.prompt_id}\` #${fail.run_index}: ${JSON.stringify(fail.validation_reasons)} error=${fail.error}`
      )
    }
  }
  lines.push('')
  lines.push('## Interpretation')
  lines.push('')
  lines.push('_Fill in after reviewing medians, IQRs, and any failures._')
  lines.push('')
  lines.push('## Limitations')
  lines.push('')
  lines.push('- Single-host, single-model, sequential requests only.')
  lines.push(
    '- Provider blocks are ordered; cool-down reduces but does not erase thermal carryover.'
  )
  lines.push('- Effective prefill TPS is an end-to-end proxy, not native ppTPS.')
  lines.push(
    '- Prompt size labels are nominal; run-id prefixes slightly change prompt_tokens per run.'
  )
  lines.push(
    '- llama.cpp / runtime build differences across servers are part of the measured stack.'
  )
  lines.push('')
  lines.push('## Reproduction commands')
  lines.push('')
  lines.push('```bash')
  lines.push('cd packages/cli')
  lines.push('npm install')
  lines.push('npx tsx benchmarks/serve-openai-providers/benchmark.ts digest')
  lines.push('npx tsx benchmarks/serve-openai-providers/benchmark.ts preflight')
  lines.push('npx tsx benchmarks/serve-openai-providers/benchmark.ts smoke')
  lines.push('npx tsx benchmarks/serve-openai-providers/benchmark.ts full')
  lines.push('```')
  lines.push('')

  writeFileSync(path, lines.join('\n'), 'utf8')
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
          `measured ${provider.id} ${promptId}#${i} ok=${run.ok} ttft_ms=${m.ttft_ms} decode_tps=${m.decode_tps}`
        )
      }
    }

    if (providerIndex < config.providers.length - 1 && cooldownSeconds > 0) {
      console.log(`cooldown ${cooldownSeconds}s before next provider`)
      await sleep(cooldownSeconds * 1000)
    }
  }

  const reportPath = join(sessionDir, 'report.md')
  writeReport(raw, reportPath)
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
  const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as Record<string, unknown>
  writeReport(raw, reportPath)
  console.log(`wrote ${reportPath}`)
  return 0
}
