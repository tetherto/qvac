import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { main } from './benchmark'
import { cmdFull, cmdPreflight, defaultDependencies, rotateIds } from './commands'
import type { CommandDependencies } from './commands'
import { loadBenchmarkConfig } from './config'
import { atomicWriteJson, verifyModelParity } from './persistence'
import { executeCommand, runProviderLifecycle } from './lifecycle'
import { aggregateMetric, computeMetrics, validateRun } from './metrics'
import { writeReport } from './report'
import { buildMessages, createFakeChunk, parseStream } from './stream'
import type {
  BenchmarkConfig,
  ChatClient,
  ProviderConfig,
  PromptsFile,
  RawDocument,
  StreamParseResult,
  StreamTimings
} from './types'

function makeConfig(params: { ggufPath: string; sha256: string }): BenchmarkConfig {
  return {
    generation: { max_tokens: 128 },
    prompt_ids: ['short'],
    providers: [{ id: 'qvac', base_url: 'http://127.0.0.1:11435/v1', model: 'model' }],
    model_parity: {
      gguf_path: params.ggufPath,
      sha256: params.sha256
    }
  }
}

function writeConfig(path: string, config: object): void {
  writeFileSync(path, JSON.stringify(config), 'utf8')
}

function ignoreError(): void {}

const promptsDoc: PromptsFile = {
  parity: { id: 'parity', content: 'hello' },
  prompts: [{ id: 'short', content: 'hello' }]
}

function makeParsed(overrides: {
  requestStartS?: number
  firstContentS?: number | null
  lastContentS?: number | null
  streamEndS?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
}): StreamParseResult {
  return {
    content: 'answer',
    reasoningContent: '',
    promptTokens: 'promptTokens' in overrides ? (overrides.promptTokens ?? null) : 10,
    completionTokens: 'completionTokens' in overrides ? (overrides.completionTokens ?? null) : 5,
    responseModel: 'm',
    timings: {
      requestStartS: overrides.requestStartS ?? 0,
      firstContentS: overrides.firstContentS ?? 0.1,
      lastContentS: overrides.lastContentS ?? 0.2,
      streamEndS: overrides.streamEndS ?? 1
    },
    error: null
  }
}

function validateRunFromUsage(promptTokens: number, completionTokens: number) {
  const parsed = makeParsed({ promptTokens, completionTokens })
  return validateRun({ parsed, metrics: computeMetrics(parsed) })
}

// Preflight requests omit the run-id prefix; measured/warmup requests carry it.
// The fake answers preflight with a valid completion and fails measured runs.
function makeMeasuredFailureClient(): ChatClient {
  return {
    chat: {
      completions: {
        create: (kwargs) => {
          const content = String(kwargs.messages[0]?.content ?? '')
          if (content.includes('[run:')) {
            return Promise.resolve([createFakeChunk({ emptyChoices: true })])
          }
          return Promise.resolve([
            createFakeChunk({ content: 'answer' }),
            createFakeChunk({
              emptyChoices: true,
              usage: { promptTokens: 5, completionTokens: 3 }
            })
          ])
        }
      }
    }
  }
}

function makeSuccessfulClient(
  providerId: string,
  promptTokens: number,
  events?: string[]
): ChatClient {
  return {
    chat: {
      completions: {
        create: (kwargs) => {
          const content = String(kwargs.messages[0]?.content ?? '')
          events?.push(`${providerId}:${content.includes('[run:') ? 'measured' : 'parity'}`)
          return Promise.resolve([
            createFakeChunk({ content: 'answer' }),
            createFakeChunk({
              emptyChoices: true,
              usage: { promptTokens, completionTokens: 3 }
            })
          ])
        }
      }
    }
  }
}

describe('serve-openai-providers harness', () => {
  it('returns a rejected promise for an invalid benchmark config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-main-'))
    try {
      const configPath = join(dir, 'benchmark.yaml')
      writeConfig(configPath, { providers: [] })

      await assert.rejects(main(['digest', '--config', configPath]), /generation settings/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns a rejected promise for a missing prompts file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-main-'))
    try {
      const configPath = join(dir, 'benchmark.yaml')
      const promptsPath = join(dir, 'missing-prompts.json')
      writeConfig(
        configPath,
        makeConfig({ ggufPath: join(dir, 'model.gguf'), sha256: 'a'.repeat(64) })
      )

      await assert.rejects(
        main(['digest', '--config', configPath, '--prompts', promptsPath]),
        /ENOENT.*missing-prompts\.json/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('verifies the configured GGUF digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-digest-'))
    try {
      const ggufPath = join(dir, 'model.gguf')
      const bytes = Buffer.from('gguf')
      writeFileSync(ggufPath, bytes)
      const expected = createHash('sha256').update(bytes).digest('hex')

      const evidence = await verifyModelParity(makeConfig({ ggufPath, sha256: expected }))

      assert.equal(evidence.path, ggufPath)
      assert.equal(evidence.sha256, expected)
      assert.equal(evidence.bytes, 4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a mismatched GGUF digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-digest-'))
    try {
      const ggufPath = join(dir, 'model.gguf')
      writeFileSync(ggufPath, 'gguf')

      await assert.rejects(
        verifyModelParity(makeConfig({ ggufPath, sha256: '0'.repeat(64) })),
        /GGUF SHA-256 mismatch/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces the GGUF digest before preflight provider requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-preflight-'))
    try {
      const ggufPath = join(dir, 'model.gguf')
      writeFileSync(ggufPath, 'gguf')
      const config = makeConfig({ ggufPath, sha256: '0'.repeat(64) })
      config.providers[0]!.base_url = 'http://127.0.0.1:1/v1'

      await assert.rejects(cmdPreflight(config, promptsDoc), /GGUF SHA-256 mismatch/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists GGUF digest evidence in preflight raw output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-preflight-'))
    const originalConsoleError = console.error
    try {
      console.error = ignoreError
      const ggufPath = join(dir, 'model.gguf')
      const bytes = Buffer.from('gguf')
      writeFileSync(ggufPath, bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const config = makeConfig({ ggufPath, sha256 })
      config.providers = []

      assert.equal(await cmdPreflight(config, promptsDoc, dir), 1)
      const raw = JSON.parse(readFileSync(join(dir, 'raw.json'), 'utf8')) as Record<string, unknown>
      assert.deepEqual(raw['model_parity_evidence'], {
        path: ggufPath,
        bytes: 4,
        sha256
      })
    } finally {
      console.error = originalConsoleError
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the injected date for preflight session artifacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-preflight-'))
    const originalConsoleError = console.error
    try {
      console.error = ignoreError
      const ggufPath = join(dir, 'model.gguf')
      const bytes = Buffer.from('gguf')
      writeFileSync(ggufPath, bytes)
      const config = makeConfig({
        ggufPath,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
      config.providers = []
      const deps: CommandDependencies = {
        ...defaultDependencies(),
        clock: {
          ...defaultDependencies().clock,
          date: () => new Date('2026-07-22T12:34:56.000Z')
        }
      }

      assert.equal(await cmdPreflight(config, promptsDoc, dir, deps), 1)
      const raw = JSON.parse(readFileSync(join(dir, 'raw.json'), 'utf8')) as {
        created_at: string
      }
      assert.equal(raw.created_at, '2026-07-22T12:34:56.000Z')
    } finally {
      console.error = originalConsoleError
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('full command persists a measured failure and stops the provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-full-'))
    const originalLog = console.log
    const originalError = console.error
    try {
      console.log = ignoreError
      console.error = ignoreError
      const ggufPath = join(dir, 'model.gguf')
      const bytes = Buffer.from('gguf')
      writeFileSync(ggufPath, bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const config = makeConfig({ ggufPath, sha256 })
      config.warmup_runs = 0
      config.measured_runs = 1
      config.cooldown_seconds = 0
      config.providers = [
        {
          id: 'qvac',
          base_url: 'http://127.0.0.1:11435/v1',
          model: 'model',
          lifecycle: {
            start_command: ['start-provider'],
            stop_command: ['stop-provider']
          }
        }
      ]

      const events: string[] = []
      const deps: CommandDependencies = {
        ...defaultDependencies(),
        createClient: () => makeMeasuredFailureClient(),
        execute: (command) => {
          events.push(command[0]!)
          return Promise.resolve()
        }
      }

      const code = await cmdFull(config, promptsDoc, dir, deps)
      assert.equal(code, 1)
      assert.ok(events.includes('stop-provider'))

      const raw = JSON.parse(readFileSync(join(dir, 'results', 'raw.json'), 'utf8')) as {
        runs: Array<Record<string, unknown>>
      }
      const measuredFailure = raw.runs.find(
        (run) => run['phase'] === 'measured' && run['ok'] === false
      )
      assert.ok(measuredFailure)
    } finally {
      console.log = originalLog
      console.error = originalError
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('full command runs parity and measurements in one sequential session per provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-full-'))
    const originalLog = console.log
    const originalError = console.error
    try {
      console.log = ignoreError
      console.error = ignoreError
      const ggufPath = join(dir, 'model.gguf')
      const bytes = Buffer.from('gguf')
      writeFileSync(ggufPath, bytes)
      const config = makeConfig({
        ggufPath,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
      config.warmup_runs = 0
      config.measured_runs = 1
      config.cooldown_seconds = 0
      config.providers = ['first', 'second'].map((id, index) => ({
        id,
        base_url: `http://127.0.0.1:${11435 + index}/v1`,
        model: 'model',
        lifecycle: {
          start_command: [`start-${id}`],
          stop_command: [`stop-${id}`]
        }
      }))

      const events: string[] = []
      const deps: CommandDependencies = {
        ...defaultDependencies(),
        createClient: (baseUrl) => {
          const providerId = baseUrl.includes('11435') ? 'first' : 'second'
          return makeSuccessfulClient(providerId, 5, events)
        },
        execute: (command) => {
          events.push(command[0]!)
          return Promise.resolve()
        }
      }

      assert.equal(await cmdFull(config, promptsDoc, dir, deps), 0)
      assert.deepEqual(events, [
        'start-first',
        'first:parity',
        'first:measured',
        'stop-first',
        'start-second',
        'second:parity',
        'second:measured',
        'stop-second'
      ])
    } finally {
      console.log = originalLog
      console.error = originalError
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('full command persists parity mismatch and marks the report invalid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-full-'))
    const originalLog = console.log
    const originalError = console.error
    try {
      console.log = ignoreError
      console.error = ignoreError
      const ggufPath = join(dir, 'model.gguf')
      const bytes = Buffer.from('gguf')
      writeFileSync(ggufPath, bytes)
      const config = makeConfig({
        ggufPath,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
      config.warmup_runs = 0
      config.measured_runs = 1
      config.cooldown_seconds = 0
      config.providers = ['first', 'second'].map((id, index) => ({
        id,
        base_url: `http://127.0.0.1:${11435 + index}/v1`,
        model: 'model'
      }))
      const deps: CommandDependencies = {
        ...defaultDependencies(),
        createClient: (baseUrl) =>
          makeSuccessfulClient(
            baseUrl.includes('11435') ? 'first' : 'second',
            baseUrl.includes('11435') ? 5 : 6
          )
      }

      assert.equal(await cmdFull(config, promptsDoc, dir, deps), 1)
      const raw = JSON.parse(readFileSync(join(dir, 'results', 'raw.json'), 'utf8')) as {
        parity: { prompt_tokens_equal: boolean }
        runs: Array<Record<string, unknown>>
        valid: boolean
        invalid_reasons: string[]
      }
      assert.equal(raw.parity.prompt_tokens_equal, false)
      assert.equal(raw.runs.filter((run) => run['phase'] === 'measured').length, 2)
      assert.equal(raw.valid, false)
      assert.ok(raw.invalid_reasons.includes('prompt_tokens_parity_mismatch'))
      assert.match(
        readFileSync(join(dir, 'results', 'report.md'), 'utf8'),
        /Benchmark validity: INVALID/
      )
    } finally {
      console.log = originalLog
      console.error = originalError
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('full command finalizes partial results after a later provider start failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-full-'))
    const originalLog = console.log
    const originalError = console.error
    try {
      console.log = ignoreError
      console.error = ignoreError
      const ggufPath = join(dir, 'model.gguf')
      const bytes = Buffer.from('gguf')
      writeFileSync(ggufPath, bytes)
      const config = makeConfig({
        ggufPath,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
      config.warmup_runs = 0
      config.measured_runs = 1
      config.cooldown_seconds = 0
      config.providers = ['first', 'second'].map((id, index) => ({
        id,
        base_url: `http://127.0.0.1:${11435 + index}/v1`,
        model: 'model',
        lifecycle: {
          start_command: [`start-${id}`],
          stop_command: [`stop-${id}`]
        }
      }))
      const events: string[] = []
      const deps: CommandDependencies = {
        ...defaultDependencies(),
        createClient: (baseUrl) =>
          makeSuccessfulClient(baseUrl.includes('11435') ? 'first' : 'second', 5),
        execute: (command) => {
          events.push(command[0]!)
          if (command[0] === 'start-second') {
            return Promise.reject(new Error('second failed to start'))
          }
          return Promise.resolve()
        },
        clock: {
          ...defaultDependencies().clock,
          date: () => new Date('2026-07-22T12:00:00.000Z')
        }
      }

      assert.equal(await cmdFull(config, promptsDoc, dir, deps), 1)
      assert.ok(events.includes('stop-second'))
      const raw = JSON.parse(readFileSync(join(dir, 'results', 'raw.json'), 'utf8')) as {
        created_at: string
        runs: Array<{ provider: string; started_at: string; ended_at: string }>
        orchestration_errors: Array<{ provider: string; message: string }>
      }
      assert.equal(raw.created_at, '2026-07-22T12:00:00.000Z')
      assert.equal(raw.runs.filter((run) => run.provider === 'first').length, 1)
      assert.equal(raw.runs[0]!.started_at, '2026-07-22T12:00:00.000Z')
      assert.equal(raw.runs[0]!.ended_at, '2026-07-22T12:00:00.000Z')
      assert.match(raw.orchestration_errors[0]!.message, /second failed to start/)
      assert.ok(readFileSync(join(dir, 'results', 'report.md'), 'utf8').includes('INVALID'))
    } finally {
      console.log = originalLog
      console.error = originalError
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads a strict benchmark config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-config-'))
    try {
      const path = join(dir, 'benchmark.yaml')
      const config = makeConfig({
        ggufPath: join(dir, 'model.gguf'),
        sha256: 'a'.repeat(64)
      })
      config.generation = {
        max_tokens: 128,
        temperature: 0,
        seed: 42,
        stream: true,
        stream_options: { include_usage: true }
      }
      config.warmup_runs = 0
      config.measured_runs = 1
      config.cooldown_seconds = 0.5
      config.session_dir = 'results'
      config.api_key = 'local-key'
      config.parity_prompt_id = 'parity'
      writeConfig(path, config)

      assert.deepEqual(loadBenchmarkConfig(path), config)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs the digest command with an empty configured digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-config-'))
    const originalLog = console.log
    try {
      console.log = ignoreError
      const path = join(dir, 'benchmark.yaml')
      const ggufPath = join(dir, 'model.gguf')
      const promptsPath = join(dir, 'prompts.json')
      const config = makeConfig({
        ggufPath,
        sha256: ''
      })
      writeFileSync(ggufPath, 'gguf')
      writeFileSync(promptsPath, JSON.stringify(promptsDoc), 'utf8')
      writeConfig(path, config)

      assert.equal(await main(['digest', '--config', path, '--prompts', promptsPath]), 0)
    } finally {
      console.log = originalLog
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads a benchmark config with a missing digest for the digest command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-config-'))
    try {
      const path = join(dir, 'benchmark.yaml')
      const config = makeConfig({
        ggufPath: join(dir, 'model.gguf'),
        sha256: 'a'.repeat(64)
      })
      delete config.model_parity.sha256
      writeConfig(path, config)

      assert.deepEqual(loadBenchmarkConfig(path), config)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  for (const [name, update] of [
    ['empty providers', { providers: [] }],
    ['empty prompt IDs', { prompt_ids: [] }],
    ['empty generation settings', { generation: {} }],
    ['relative GGUF path', { model_parity: { gguf_path: 'model.gguf', sha256: 'a'.repeat(64) } }],
    [
      'invalid GGUF digest',
      { model_parity: { gguf_path: '/tmp/model.gguf', sha256: 'A'.repeat(64) } }
    ]
  ] as const) {
    it(`rejects benchmark config with ${name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'bench-config-'))
      try {
        const path = join(dir, 'benchmark.yaml')
        const config = {
          ...makeConfig({
            ggufPath: join(dir, 'model.gguf'),
            sha256: 'a'.repeat(64)
          }),
          ...update
        }
        writeConfig(path, config)

        assert.throws(() => loadBenchmarkConfig(path))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  for (const [name, update] of [
    ['unknown generation key', { generation: { max_tokens: 128, unexpected: true } }],
    ['string max_tokens', { generation: { max_tokens: '128' } }],
    ['non-object stream_options', { generation: { stream_options: true } }],
    ['string warmup_runs', { warmup_runs: '1' }],
    ['negative warmup_runs', { warmup_runs: -1 }],
    ['zero measured_runs', { measured_runs: 0 }],
    ['fractional measured_runs', { measured_runs: 1.5 }],
    ['string cooldown_seconds', { cooldown_seconds: '90' }],
    ['negative cooldown_seconds', { cooldown_seconds: -1 }]
  ] as const) {
    it(`rejects malformed benchmark config with ${name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'bench-config-'))
      try {
        const path = join(dir, 'benchmark.yaml')
        const config = {
          ...makeConfig({
            ggufPath: join(dir, 'model.gguf'),
            sha256: 'a'.repeat(64)
          }),
          ...update
        }
        writeConfig(path, config)

        assert.throws(() => loadBenchmarkConfig(path))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  for (const [name, update] of [
    ['unknown root key', { unexpected: true }],
    ['non-string session_dir', { session_dir: 123 }],
    ['empty session_dir', { session_dir: ' ' }],
    ['non-string api_key', { api_key: 123 }],
    ['empty api_key', { api_key: ' ' }],
    ['non-string parity_prompt_id', { parity_prompt_id: 123 }],
    ['empty parity_prompt_id', { parity_prompt_id: ' ' }],
    ['disabled streaming', { generation: { max_tokens: 128, stream: false } }]
  ] as const) {
    it(`rejects strict root config with ${name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'bench-config-'))
      try {
        const path = join(dir, 'benchmark.yaml')
        const config = {
          ...makeConfig({
            ggufPath: join(dir, 'model.gguf'),
            sha256: 'a'.repeat(64)
          }),
          ...update
        }
        writeConfig(path, config)

        assert.throws(() => loadBenchmarkConfig(path))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('loads provider lifecycle commands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-config-'))
    try {
      const path = join(dir, 'benchmark.yaml')
      const config = makeConfig({
        ggufPath: join(dir, 'model.gguf'),
        sha256: 'a'.repeat(64)
      })
      config.providers = [
        {
          id: 'qvac',
          base_url: 'http://127.0.0.1:11435/v1',
          model: 'model',
          lifecycle: {
            start_command: ['serve', '--port', '11435'],
            stop_command: ['pkill', 'serve'],
            timeout_seconds: 45
          }
        }
      ]
      writeConfig(path, config)

      assert.deepEqual(loadBenchmarkConfig(path), config)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  for (const [name, providers] of [
    ['unknown provider key', [{ id: 'qvac', base_url: 'http://x/v1', model: 'm', extra: true }]],
    [
      'string lifecycle start_command',
      [{ id: 'qvac', base_url: 'http://x/v1', model: 'm', lifecycle: { start_command: 'serve' } }]
    ],
    [
      'empty lifecycle stop_command',
      [{ id: 'qvac', base_url: 'http://x/v1', model: 'm', lifecycle: { stop_command: [] } }]
    ],
    [
      'blank lifecycle command entry',
      [{ id: 'qvac', base_url: 'http://x/v1', model: 'm', lifecycle: { start_command: [' '] } }]
    ],
    [
      'unknown lifecycle key',
      [{ id: 'qvac', base_url: 'http://x/v1', model: 'm', lifecycle: { restart: ['serve'] } }]
    ],
    [
      'non-object lifecycle',
      [{ id: 'qvac', base_url: 'http://x/v1', model: 'm', lifecycle: true }]
    ],
    [
      'zero lifecycle timeout',
      [{ id: 'qvac', base_url: 'http://x/v1', model: 'm', lifecycle: { timeout_seconds: 0 } }]
    ],
    [
      'string lifecycle timeout',
      [
        {
          id: 'qvac',
          base_url: 'http://x/v1',
          model: 'm',
          lifecycle: { timeout_seconds: '30' }
        }
      ]
    ]
  ] as const) {
    it(`rejects strict provider config with ${name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'bench-config-'))
      try {
        const path = join(dir, 'benchmark.yaml')
        const config = {
          ...makeConfig({
            ggufPath: join(dir, 'model.gguf'),
            sha256: 'a'.repeat(64)
          }),
          providers
        }
        writeConfig(path, config)

        assert.throws(() => loadBenchmarkConfig(path))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('ignores role-only and reasoning-only chunks for first content', async () => {
    const timings: StreamTimings = {
      requestStartS: 100,
      firstContentS: null,
      lastContentS: null,
      streamEndS: null
    }
    const clock = [100.5, 100.8, 101.0]
    function now(): number {
      const next = clock.shift()
      assert.ok(next !== undefined)
      return next
    }
    const chunks = [
      createFakeChunk({ role: 'assistant', content: null }),
      createFakeChunk({ reasoningContent: 'thinking...' }),
      createFakeChunk({ content: 'Hello' }),
      createFakeChunk({ content: ' world' }),
      createFakeChunk({
        emptyChoices: true,
        usage: { promptTokens: 12, completionTokens: 4 },
        model: 'm'
      })
    ]
    const parsed = await parseStream(chunks, timings, now)
    assert.equal(parsed.content, 'Hello world')
    assert.equal(parsed.reasoningContent, 'thinking...')
    assert.equal(timings.firstContentS, 100.5)
    assert.equal(timings.lastContentS, 100.8)
    assert.equal(parsed.promptTokens, 12)
    assert.equal(parsed.completionTokens, 4)
  })

  it('requires and extracts final usage', async () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: null,
      lastContentS: null,
      streamEndS: null
    }
    const chunks = [
      createFakeChunk({ content: 'x' }),
      createFakeChunk({
        emptyChoices: true,
        usage: { promptTokens: 100, completionTokens: 8 }
      })
    ]
    const parsed = await parseStream(chunks, timings, () => 1)
    const metrics = computeMetrics(parsed)
    const validation = validateRun({ parsed, metrics })
    assert.equal(validation.ok, true)
    assert.equal(metrics.promptTokens, 100)
    assert.equal(metrics.completionTokens, 8)
  })

  it('computes client output and effective prefill formulas', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: 0.5,
      lastContentS: 1.5,
      streamEndS: 1.6
    }
    const parsed: StreamParseResult = {
      content: 'abcd',
      reasoningContent: '',
      promptTokens: 200,
      completionTokens: 11,
      responseModel: 'm',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    assert.equal(metrics.ttftMs, 500)
    assert.equal(metrics.totalMs, 1600)
    assert.equal(metrics.clientOutputTps, 6.875)
    assert.equal(metrics.effectivePrefillTps, 400)
  })

  it('computes client output throughput over the full request window', () => {
    const metrics = computeMetrics(
      makeParsed({
        requestStartS: 0,
        firstContentS: 0.5,
        lastContentS: 1.2,
        streamEndS: 2,
        completionTokens: 10
      })
    )
    assert.equal(metrics.clientOutputTps, 5)
  })

  it('does not expose chunk-boundary decode TPS', () => {
    const metrics = computeMetrics(makeParsed({ completionTokens: 10 }))
    assert.equal('decodeTps' in metrics, false)
  })

  it('computes client output throughput for one completion token', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: 0.1,
      lastContentS: 0.2,
      streamEndS: 0.3
    }
    const parsed: StreamParseResult = {
      content: 'x',
      reasoningContent: '',
      promptTokens: 10,
      completionTokens: 1,
      responseModel: 'm',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    assert.equal(metrics.clientOutputTps, 1 / 0.3)
  })

  it('aggregates median quartiles and IQR for five values', () => {
    const stats = aggregateMetric([10, 20, 30, 40, 50].map((value) => ({ value, ok: true })))
    assert.equal(stats.nValid, 5)
    assert.equal(stats.median, 30)
    assert.equal(stats.p25, 20)
    assert.equal(stats.p75, 40)
    assert.equal(stats.iqr, 20)
  })

  it('excludes failed/null values from aggregates', () => {
    const stats = aggregateMetric([
      { value: 10, ok: true },
      { value: null, ok: true },
      { value: 30, ok: true },
      { value: null, ok: false }
    ])
    assert.equal(stats.nValid, 2)
    assert.equal(stats.nFailed, 1)
    assert.equal(stats.median, 20)
  })

  it('reports attempted valid unavailable and failed samples', () => {
    const stats = aggregateMetric([
      { value: 10, ok: true },
      { value: null, ok: true },
      { value: null, ok: false }
    ])
    assert.deepEqual(
      {
        attempted: stats.nAttempted,
        valid: stats.nValid,
        unavailable: stats.nUnavailable,
        failed: stats.nFailed
      },
      { attempted: 3, valid: 1, unavailable: 1, failed: 1 }
    )
  })

  it('classifies successful non-finite values as unavailable', () => {
    const stats = aggregateMetric([
      { value: 10, ok: true },
      { value: Number.NaN, ok: true },
      { value: Number.POSITIVE_INFINITY, ok: true },
      { value: null, ok: true },
      { value: null, ok: false }
    ])
    assert.deepEqual(
      {
        attempted: stats.nAttempted,
        valid: stats.nValid,
        unavailable: stats.nUnavailable,
        failed: stats.nFailed
      },
      { attempted: 5, valid: 1, unavailable: 3, failed: 1 }
    )
    assert.equal(stats.nAttempted, stats.nValid + stats.nUnavailable + stats.nFailed)
  })

  it('renders documented report wording, commands, counts, and final newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-report-'))
    try {
      const path = join(dir, 'report.md')
      const raw: RawDocument = {
        session_id: 'test-session',
        created_at: '2026-07-22T00:00:00.000Z',
        config_snapshot: {
          generation: {},
          cooldown_seconds: 0,
          prompt_ids: ['short'],
          providers: [{ id: 'qvac', base_url: 'http://localhost', model: 'model' }],
          model_parity: { gguf_path: '/tmp/model.gguf' }
        },
        provider_order: ['qvac'],
        parity: {},
        runs: [
          {
            provider: 'qvac',
            prompt_id: 'short',
            phase: 'measured',
            run_index: 0,
            ok: true,
            metrics: {
              ttft_ms: 10,
              total_ms: 20,
              client_output_tps: 30,
              effective_prefill_tps: 40
            }
          },
          {
            provider: 'qvac',
            prompt_id: 'short',
            phase: 'measured',
            run_index: 1,
            ok: true,
            metrics: {
              ttft_ms: null,
              total_ms: null,
              client_output_tps: null,
              effective_prefill_tps: null
            }
          },
          {
            provider: 'qvac',
            prompt_id: 'short',
            phase: 'measured',
            run_index: 2,
            ok: false,
            metrics: {
              ttft_ms: null,
              total_ms: null,
              client_output_tps: null,
              effective_prefill_tps: null
            }
          }
        ]
      }
      writeReport(raw, path)
      const report = readFileSync(path, 'utf8')
      const expectedCounts = 'valid=1, unavailable=1, failed=1, attempted=3'
      assert.equal(report.split(expectedCounts).length - 1, 4)
      assert.ok(
        report.includes(
          'Client output TPS: `completion_tokens / total_s` (end to end; includes HTTP, queueing, prompt processing, and first-token time; not native decode TPS)'
        )
      )
      assert.ok(
        report.includes(
          'The local source manifest is `environment.md`; protected full CI copies it to `results/environment.md` in the uploaded artifact.'
        )
      )
      assert.ok(report.includes('export BENCHMARK_CONFIG_PATH=/absolute/path/to/benchmark.yaml'))
      assert.ok(
        report.includes(
          'npx tsx benchmarks/serve-openai-providers/benchmark.ts full --config "$BENCHMARK_CONFIG_PATH"'
        )
      )
      assert.equal(report.endsWith('\n'), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists results atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-'))
    try {
      const path = join(dir, 'raw.json')
      const payload: { runs: Array<{ id: number }> } = { runs: [{ id: 1 }] }
      atomicWriteJson(path, payload)
      payload.runs.push({ id: 2 })
      atomicWriteJson(path, payload)
      const loaded = JSON.parse(readFileSync(path, 'utf8')) as typeof payload
      assert.deepEqual(loaded.runs, [{ id: 1 }, { id: 2 }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails validation for missing usage and empty output', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: null,
      lastContentS: null,
      streamEndS: 1
    }
    const parsed: StreamParseResult = {
      content: '',
      reasoningContent: '',
      promptTokens: null,
      completionTokens: null,
      responseModel: 'm',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    const validation = validateRun({ parsed, metrics })
    assert.equal(validation.ok, false)
    assert.ok(validation.reasons.includes('empty_content'))
    assert.ok(validation.reasons.includes('missing_usage'))
  })

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    it(`rejects invalid completion usage ${String(value)}`, () => {
      const validation = validateRunFromUsage(10, value)
      assert.equal(validation.ok, false)
      assert.ok(validation.reasons.includes('invalid_completion_tokens'))
    })
  }

  it('reports malformed completion usage when prompt usage is missing', () => {
    const parsed = makeParsed({ promptTokens: null, completionTokens: Number.NaN })
    const validation = validateRun({ parsed, metrics: computeMetrics(parsed) })
    assert.equal(validation.ok, false)
    assert.ok(validation.reasons.includes('missing_usage'))
    assert.ok(validation.reasons.includes('invalid_completion_tokens'))
  })

  it('fails validation when think markers appear in content', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: 0.1,
      lastContentS: 0.2,
      streamEndS: 0.3
    }
    const parsed: StreamParseResult = {
      content: '<think>secret</think>answer',
      reasoningContent: '',
      promptTokens: 5,
      completionTokens: 5,
      responseModel: 'm',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    const validation = validateRun({ parsed, metrics })
    assert.equal(validation.ok, false)
    assert.ok(validation.reasons.some((r) => r.startsWith('think_marker_in_content')))
  })

  it('fails validation when reasoning content is non-empty', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: 0.1,
      lastContentS: 0.2,
      streamEndS: 0.3
    }
    const parsed: StreamParseResult = {
      content: 'answer',
      reasoningContent: 'chain',
      promptTokens: 5,
      completionTokens: 5,
      responseModel: 'm',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    const validation = validateRun({ parsed, metrics })
    assert.equal(validation.ok, false)
    assert.ok(validation.reasons.includes('reasoning_content_non_empty'))
  })

  it('rotates prompt ids', () => {
    assert.deepEqual(rotateIds(['a', 'b', 'c'], 1), ['b', 'c', 'a'])
  })

  it('inserts run ids into messages', () => {
    assert.deepEqual(buildMessages('hello', 'abc'), [{ role: 'user', content: '[run:abc] hello' }])
  })

  it('does not fail when response model differs from request model', () => {
    const timings: StreamTimings = {
      requestStartS: 0,
      firstContentS: 0.1,
      lastContentS: 0.2,
      streamEndS: 0.3
    }
    const parsed: StreamParseResult = {
      content: 'answer',
      reasoningContent: '',
      promptTokens: 5,
      completionTokens: 5,
      responseModel: 'some-other-visible-id',
      timings,
      error: null
    }
    const metrics = computeMetrics(parsed)
    const validation = validateRun({ parsed, metrics })
    assert.equal(validation.ok, true)
    assert.ok(!validation.reasons.some((r) => r.startsWith('model_mismatch')))
  })

  it('counts measured failures for fail-closed full', () => {
    const runs = [
      { phase: 'warmup', ok: false },
      { phase: 'measured', ok: true },
      { phase: 'measured', ok: false }
    ]
    const measuredFailures = runs.filter((r) => r.phase === 'measured' && !r.ok)
    assert.equal(measuredFailures.length, 1)
    assert.equal(measuredFailures.length > 0 ? 1 : 0, 1)
  })

  const providerWithCommands: ProviderConfig = {
    id: 'qvac',
    base_url: 'http://127.0.0.1:11435/v1',
    model: 'model',
    lifecycle: {
      start_command: ['start-provider'],
      stop_command: ['stop-provider']
    }
  }

  it('starts and stops one provider around its operation', async () => {
    const events: string[] = []
    const result = await runProviderLifecycle(
      providerWithCommands,
      () => {
        events.push('request')
        return Promise.resolve(7)
      },
      (command) => {
        events.push(command[0]!)
        return Promise.resolve()
      }
    )
    assert.equal(result, 7)
    assert.deepEqual(events, ['start-provider', 'request', 'stop-provider'])
  })

  it('stops the provider when its request fails', async () => {
    const events: string[] = []
    const executeRecordingCommand = (command: string[]): Promise<void> => {
      events.push(command[0]!)
      return Promise.resolve()
    }
    await assert.rejects(
      runProviderLifecycle(
        providerWithCommands,
        () => Promise.reject(new Error('request failed')),
        executeRecordingCommand
      ),
      /request failed/
    )
    assert.deepEqual(events, ['start-provider', 'stop-provider'])
  })

  it('runs the operation without lifecycle commands', async () => {
    const provider: ProviderConfig = { id: 'plain', base_url: 'http://127.0.0.1:1/v1', model: 'm' }
    let executed = 0
    const result = await runProviderLifecycle(
      provider,
      () => Promise.resolve(42),
      () => {
        executed += 1
        return Promise.resolve()
      }
    )
    assert.equal(result, 42)
    assert.equal(executed, 0)
  })

  it('surfaces a stop failure after a successful operation', async () => {
    const failingStop = (command: string[]): Promise<void> => {
      if (command[0] === 'stop-provider') {
        return Promise.reject(new Error('stop failed'))
      }
      return Promise.resolve()
    }
    await assert.rejects(
      runProviderLifecycle(providerWithCommands, () => Promise.resolve(1), failingStop),
      /stop failed/
    )
  })

  it('preserves the operation error when stop also fails', async () => {
    const failingStop = (command: string[]): Promise<void> => {
      if (command[0] === 'stop-provider') {
        return Promise.reject(new Error('stop failed'))
      }
      return Promise.resolve()
    }
    await assert.rejects(
      runProviderLifecycle(
        providerWithCommands,
        () => Promise.reject(new Error('request failed')),
        failingStop
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.errors.length, 2)
        assert.match(String(error.errors[0]), /request failed/)
        assert.match(String(error.errors[1]), /stop failed/)
        return true
      }
    )
  })

  it('preserves an undefined operation rejection', async () => {
    let rejected = false
    let rejection: unknown = Symbol('not rejected')
    try {
      await runProviderLifecycle(
        providerWithCommands,
        () => Promise.reject(undefined),
        () => Promise.resolve()
      )
    } catch (error) {
      rejected = true
      rejection = error
    }
    assert.equal(rejected, true)
    assert.equal(rejection, undefined)
  })

  it('preserves an undefined stop rejection', async () => {
    let rejected = false
    let rejection: unknown = Symbol('not rejected')
    try {
      await runProviderLifecycle(
        providerWithCommands,
        () => Promise.resolve(1),
        (command) =>
          command[0] === 'stop-provider' ? Promise.reject(undefined) : Promise.resolve()
      )
    } catch (error) {
      rejected = true
      rejection = error
    }
    assert.equal(rejected, true)
    assert.equal(rejection, undefined)
  })

  it('aggregates undefined operation and stop rejections', async () => {
    await assert.rejects(
      runProviderLifecycle(
        providerWithCommands,
        () => Promise.reject(undefined),
        (command) =>
          command[0] === 'stop-provider' ? Promise.reject(undefined) : Promise.resolve()
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError)
        assert.deepEqual(error.errors, [undefined, undefined])
        return true
      }
    )
  })

  it('runs shell-free commands and resolves on a zero exit', async () => {
    await executeCommand(['node', '-e', 'process.exit(0)'])
  })

  it('rejects an empty lifecycle command', async () => {
    await assert.rejects(executeCommand([]), /non-empty argv/)
  })

  it('rejects a non-zero lifecycle command exit', async () => {
    await assert.rejects(executeCommand(['node', '-e', 'process.exit(3)']), /exited with code 3/)
  })

  it('rejects when the lifecycle command cannot start', async () => {
    await assert.rejects(executeCommand(['definitely-not-a-real-binary-xyz']))
  })

  it('times out a lifecycle command within the configured bound', async () => {
    await assert.rejects(
      executeCommand(['node', '-e', 'setInterval(() => {}, 1000)'], 25),
      /timed out after 25ms/
    )
  })

  it('waits for a timed-out child to close before rejecting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-lifecycle-'))
    const pidPath = join(dir, 'pid')
    let pid: number | undefined
    try {
      const script = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`
      await assert.rejects(executeCommand(['node', '-e', script], 100), /timed out after 100ms/)
      pid = Number(readFileSync(pidPath, 'utf8'))
      assert.throws(
        () => process.kill(pid!, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH'
      )
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error
          }
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('attempts stop cleanup when the start command times out', async () => {
    const events: string[] = []
    await assert.rejects(
      runProviderLifecycle(
        providerWithCommands,
        () => Promise.resolve(1),
        (command) => {
          events.push(command[0]!)
          if (command[0] === 'start-provider') {
            return Promise.reject(new Error('timed out after 25ms'))
          }
          return Promise.resolve()
        }
      ),
      /timed out after 25ms/
    )
    assert.deepEqual(events, ['start-provider', 'stop-provider'])
  })

  it('passes the configured timeout to lifecycle commands', async () => {
    const timeouts: Array<number | undefined> = []
    await runProviderLifecycle(
      {
        ...providerWithCommands,
        lifecycle: {
          ...providerWithCommands.lifecycle,
          timeout_seconds: 2.5
        }
      },
      () => Promise.resolve(1),
      (_command, timeoutMs) => {
        timeouts.push(timeoutMs)
        return Promise.resolve()
      }
    )
    assert.deepEqual(timeouts, [2500, 2500])
  })
})
