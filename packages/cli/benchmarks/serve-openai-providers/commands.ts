import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { configPlaceholders, PLACEHOLDER_PREFIXES, promptById } from './config'
import {
  appendRun,
  atomicWriteJson,
  createSessionDir,
  metricsToJson,
  newRawDocument,
  sha256File,
  verifyModelParity
} from './persistence'
import { executeCommand, runProviderLifecycle } from './lifecycle'
import { writeReport } from './report'
import { buildMessages, makeClient, nowSeconds, runStreamingCompletion } from './stream'
import type { CommandExecutor } from './lifecycle'
import type {
  BenchmarkConfig,
  ChatClient,
  GenerationConfig,
  PromptDoc,
  PromptsFile,
  ProviderConfig,
  RawDocument,
  RawRunRecord
} from './types'

export type CommandClock = {
  now: () => number
  date: () => Date
  sleep: (ms: number) => Promise<void>
}

export type CommandFilesystem = {
  readText: (path: string) => string
  writeJson: (path: string, payload: unknown) => void
  ensureDir: (path: string) => void
  copyFile: (source: string, destination: string) => void
  createSessionDir: (base: string, date: Date) => string
  statFile: (path: string) => { isFile: boolean; size: number } | null
}

export type CommandDependencies = {
  createClient: (baseUrl: string, apiKey: string) => ChatClient
  execute: CommandExecutor
  clock: CommandClock
  fs: CommandFilesystem
}

export function rotateIds(ids: string[], offset: number): string[] {
  if (ids.length === 0) {
    return []
  }
  const normalizedOffset = ((offset % ids.length) + ids.length) % ids.length
  return [...ids.slice(normalizedOffset), ...ids.slice(0, normalizedOffset)]
}

function defaultCreateClient(baseUrl: string, apiKey: string): ChatClient {
  const client = makeClient(baseUrl, apiKey)
  return {
    chat: {
      completions: {
        create: (kwargs) => client.chat.completions.create(kwargs)
      }
    }
  }
}

export function defaultDependencies(): CommandDependencies {
  return {
    createClient: defaultCreateClient,
    execute: executeCommand,
    clock: {
      now: nowSeconds,
      date: () => new Date(),
      sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
    },
    fs: {
      readText: (path) => readFileSync(path, 'utf8'),
      writeJson: atomicWriteJson,
      ensureDir: (path) => {
        mkdirSync(path, { recursive: true })
      },
      copyFile: copyFileSync,
      createSessionDir,
      statFile: (path) => {
        try {
          const stat = statSync(path)
          return { isFile: stat.isFile(), size: stat.size }
        } catch {
          return null
        }
      }
    }
  }
}

export async function runOne(params: {
  client: ChatClient
  provider: ProviderConfig
  prompt: PromptDoc
  generation: GenerationConfig
  phase: string
  runIndex: number
  clock?: CommandClock
}): Promise<RawRunRecord> {
  const clock = params.clock ?? defaultDependencies().clock
  const runId = randomBytes(5).toString('hex')
  const messages = buildMessages(params.prompt.content, runId)
  const startedAt = clock.date().toISOString()
  const [parsed, metrics, validation] = await runStreamingCompletion({
    client: params.client,
    model: params.provider.model,
    messages,
    generation: params.generation,
    now: clock.now
  })
  const endedAt = clock.date().toISOString()
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

export async function cmdDigest(
  config: BenchmarkConfig,
  deps: CommandDependencies = defaultDependencies()
): Promise<number> {
  const path = config.model_parity.gguf_path
  const stat = deps.fs.statFile(path)
  if (!stat || !stat.isFile) {
    console.error(`GGUF not found: ${path}`)
    return 1
  }
  const digest = await sha256File(path)
  console.log(JSON.stringify({ path, bytes: stat.size, sha256: digest }, null, 2))
  return 0
}

export async function cmdPreflight(
  config: BenchmarkConfig,
  promptsDoc: PromptsFile,
  sessionDir?: string,
  deps: CommandDependencies = defaultDependencies()
): Promise<number> {
  const bad = configPlaceholders(config)
  if (bad.length > 0) {
    console.error('Replace placeholders before preflight:')
    for (const item of bad) {
      console.error(`  - ${item}`)
    }
    return 1
  }

  const modelParityEvidence = await verifyModelParity(config)
  const parity = promptById(promptsDoc, config.parity_prompt_id ?? 'parity')
  const generation = config.generation
  const apiKey = config.api_key ?? 'local-benchmark-key'
  const results: Record<string, unknown> = {}
  const promptTokenCounts: Record<string, number> = {}

  for (const provider of config.providers) {
    const [parsed, metrics, validation] = await runProviderLifecycle(
      provider,
      () => {
        const client = deps.createClient(provider.base_url, apiKey)
        const messages = buildMessages(parity.content, null)
        return runStreamingCompletion({
          client,
          model: provider.model,
          messages,
          generation,
          now: deps.clock.now
        })
      },
      deps.execute
    )
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
    const raw = newRawDocument(
      config,
      sessionDir.split(/[\\/]/).pop() ?? sessionDir,
      deps.clock.date().toISOString()
    )
    raw.model_parity_evidence = modelParityEvidence
    raw.parity = { results, prompt_tokens_equal: parityOk }
    deps.fs.writeJson(rawPath, raw)
  }

  const allOk = parityOk && Object.values(results).every((v) => (v as { ok: boolean }).ok)
  return allOk ? 0 : 1
}

export async function cmdSmoke(
  config: BenchmarkConfig,
  promptsDoc: PromptsFile,
  deps: CommandDependencies = defaultDependencies()
): Promise<number> {
  const pre = await cmdPreflight(config, promptsDoc, undefined, deps)
  if (pre !== 0) {
    return pre
  }
  const shortest = config.prompt_ids[0]!
  const prompt = promptById(promptsDoc, shortest)
  const apiKey = config.api_key ?? 'local-benchmark-key'
  let failed = false
  for (const provider of config.providers) {
    const result = await runProviderLifecycle(
      provider,
      () =>
        runOne({
          client: deps.createClient(provider.base_url, apiKey),
          provider,
          prompt,
          generation: config.generation,
          phase: 'smoke',
          runIndex: 0,
          clock: deps.clock
        }),
      deps.execute
    )
    const metrics = result.metrics
    const status = result.ok ? 'OK' : 'FAIL'
    console.log(
      `[${status}] smoke ${provider.id} ${shortest}: ttft_ms=${metrics['ttft_ms']} client_output_tps=${metrics['client_output_tps']} reasons=${JSON.stringify(result.validation_reasons)}`
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
  providerId: string,
  deps: CommandDependencies = defaultDependencies()
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
  const generation: GenerationConfig = {
    ...config.generation,
    max_tokens: Math.min(config.generation.max_tokens ?? 128, 16)
  }
  const rows: Array<Record<string, unknown>> = []
  await runProviderLifecycle(
    provider,
    async () => {
      const client = deps.createClient(provider.base_url, config.api_key ?? 'local-benchmark-key')
      for (const promptId of config.prompt_ids) {
        const prompt = promptById(promptsDoc, promptId)
        const [parsed, , validation] = await runStreamingCompletion({
          client,
          model: provider.model,
          messages: buildMessages(prompt.content, 'calibrate'),
          generation,
          now: deps.clock.now
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
    },
    deps.execute
  )
  return rows.every((row) => row['ok'] && row['measured_prompt_tokens']) ? 0 : 1
}

export async function cmdFull(
  config: BenchmarkConfig,
  promptsDoc: PromptsFile,
  root: string,
  deps: CommandDependencies = defaultDependencies()
): Promise<number> {
  const sessionBase = join(root, config.session_dir ?? 'results')
  deps.fs.ensureDir(sessionBase)
  const sessionDir = deps.fs.createSessionDir(sessionBase, deps.clock.date())
  const rawPath = join(sessionDir, 'raw.json')
  const raw = newRawDocument(
    config,
    sessionDir.split(/[\\/]/).pop() ?? sessionDir,
    deps.clock.date().toISOString()
  )
  deps.fs.writeJson(rawPath, raw)

  console.log(`session: ${sessionDir}`)
  const apiKey = config.api_key ?? 'local-benchmark-key'
  const warmupRuns = config.warmup_runs ?? 1
  const measuredRuns = config.measured_runs ?? 5
  const cooldownSeconds = config.cooldown_seconds ?? 90
  const basePromptIds = [...config.prompt_ids]
  const parity = promptById(promptsDoc, config.parity_prompt_id ?? 'parity')
  const parityResults: Record<string, unknown> = {}
  const promptTokenCounts: Record<string, number> = {}

  function invalidate(reason: string): void {
    raw.valid = false
    const reasons = raw.invalid_reasons as string[]
    if (!reasons.includes(reason)) {
      reasons.push(reason)
    }
  }

  try {
    const bad = configPlaceholders(config)
    if (bad.length > 0) {
      throw new Error(`replace placeholders before full benchmark: ${bad.join(', ')}`)
    }
    raw.model_parity_evidence = await verifyModelParity(config)
    deps.fs.writeJson(rawPath, raw)

    for (let providerIndex = 0; providerIndex < config.providers.length; providerIndex += 1) {
      const provider = config.providers[providerIndex]!
      ;(raw.provider_order as string[]).push(provider.id)
      deps.fs.writeJson(rawPath, raw)
      console.log(`\n=== provider ${provider.id} ===`)
      const order = rotateIds(basePromptIds, providerIndex)
      console.log(`prompt order: ${JSON.stringify(order)}`)

      try {
        await runProviderLifecycle(
          provider,
          async () => {
            const client = deps.createClient(provider.base_url, apiKey)
            const [parsed, metrics, validation] = await runStreamingCompletion({
              client,
              model: provider.model,
              messages: buildMessages(parity.content, null),
              generation: config.generation,
              now: deps.clock.now
            })
            parityResults[provider.id] = {
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
            raw.parity = {
              results: parityResults,
              prompt_token_counts: promptTokenCounts,
              prompt_tokens_equal: null
            }
            deps.fs.writeJson(rawPath, raw)

            for (const promptId of order) {
              const prompt = promptById(promptsDoc, promptId)
              for (let i = 0; i < warmupRuns; i += 1) {
                const run = await runOne({
                  client,
                  provider,
                  prompt,
                  generation: config.generation,
                  phase: 'warmup',
                  runIndex: i,
                  clock: deps.clock
                })
                appendRun(rawPath, raw, run, deps.fs.writeJson)
                console.log(`warmup ${provider.id} ${promptId}#${i} ok=${run.ok}`)
              }
              for (let i = 0; i < measuredRuns; i += 1) {
                const run = await runOne({
                  client,
                  provider,
                  prompt,
                  generation: config.generation,
                  phase: 'measured',
                  runIndex: i,
                  clock: deps.clock
                })
                appendRun(rawPath, raw, run, deps.fs.writeJson)
                const metricsJson = run.metrics
                console.log(
                  `measured ${provider.id} ${promptId}#${i} ok=${run.ok} ttft_ms=${metricsJson['ttft_ms']} client_output_tps=${metricsJson['client_output_tps']}`
                )
              }
            }
          },
          deps.execute
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ;(raw.orchestration_errors as Array<{ provider: string; message: string }>).push({
          provider: provider.id,
          message
        })
        invalidate('provider_lifecycle_failure')
        deps.fs.writeJson(rawPath, raw)
        console.error(`FAIL provider ${provider.id}: ${message}`)
        break
      }

      if (providerIndex < config.providers.length - 1 && cooldownSeconds > 0) {
        console.log(`cooldown ${cooldownSeconds}s before next provider`)
        await deps.clock.sleep(cooldownSeconds * 1000)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ;(raw.orchestration_errors as Array<{ provider: string; message: string }>).push({
      provider: 'setup',
      message
    })
    invalidate('benchmark_setup_failure')
    console.error(`FAIL benchmark setup: ${message}`)
  }

  const uniquePromptTokenCounts = new Set(Object.values(promptTokenCounts))
  const parityOk =
    uniquePromptTokenCounts.size === 1 &&
    Object.keys(promptTokenCounts).length === config.providers.length
  raw.parity = {
    results: parityResults,
    prompt_token_counts: promptTokenCounts,
    prompt_tokens_equal: parityOk
  }
  if (!parityOk) {
    invalidate('prompt_tokens_parity_mismatch')
  }
  if (
    !Object.values(parityResults).every((result) => (result as { ok?: boolean }).ok === true) ||
    Object.keys(parityResults).length !== config.providers.length
  ) {
    invalidate('provider_parity_validation_failed')
  }

  const reportPath = join(sessionDir, 'report.md')
  deps.fs.writeJson(rawPath, raw)
  writeReport(raw as RawDocument, reportPath)
  deps.fs.writeJson(join(sessionBase, 'raw.json'), raw)
  deps.fs.copyFile(reportPath, join(sessionBase, 'report.md'))
  console.log(`wrote ${reportPath}`)
  console.log(`copied ${join(sessionBase, 'raw.json')} and ${join(sessionBase, 'report.md')}`)

  const measuredFailures = raw.runs.filter((run) => run.phase === 'measured' && !run.ok)
  if (measuredFailures.length > 0 || raw.valid === false) {
    console.error(`FAIL: ${measuredFailures.length} measured run(s) failed; see ${rawPath}`)
    return 1
  }
  return 0
}

export function cmdReport(
  rawPath: string,
  reportPath: string,
  deps: CommandDependencies = defaultDependencies()
): number {
  const raw = JSON.parse(deps.fs.readText(rawPath)) as RawDocument
  writeReport(raw, reportPath)
  console.log(`wrote ${reportPath}`)
  return 0
}
