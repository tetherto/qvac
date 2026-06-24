import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_OPTIONS,
  createOpenClawProvider,
  createQvacServeModels,
  openClawModels,
  registerQvacProvider,
  resolveOptions
} from '../src/provider-config.ts'

interface RegisteredProvider {
  readonly id: string
  readonly label: string
  readonly docsPath: string
  readonly auth: unknown[]
  readonly catalog: {
    readonly order: string
    run(): Promise<{ provider: unknown }>
  }
}

interface RegistrationApi {
  readonly pluginConfig?: Record<string, unknown>
  registerProvider(provider: RegisteredProvider): void
  registerModelCatalogProvider?(provider: RegisteredModelCatalogProvider): void
}

interface RegisteredModelCatalogProvider {
  readonly provider: string
  readonly kinds: readonly string[]
  staticCatalog(): readonly unknown[]
}

test('resolveOptions returns OpenClaw-safe defaults', () => {
  const options = resolveOptions()

  assert.deepEqual(options, DEFAULT_OPTIONS)
  assert.equal(options.model, 'qwen3.5-9b')
  assert.equal(options.ctxSize, 32768)
  assert.equal(options.tools, true)
  assert.equal(options.qvacCommand, 'qvac')
  assert.equal(options.configPath, 'qvac.config.json')
})

test('openClawModels maps the shared QVAC catalog into OpenClaw model rows', () => {
  const model = openClawModels.find((entry) => entry.id === 'qwen3.5-9b')

  assert.ok(model)
  assert.equal(model.name, 'Qwen3.5 9B')
  assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.reasoning, true)
  assert.equal(model.contextWindow, 32768)
  assert.equal(model.maxTokens, 8192)
  assert.deepEqual(model.compat, { requiresStringContent: true })
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('createOpenClawProvider builds a localService-backed OpenAI-compatible provider', () => {
  const provider = createOpenClawProvider(resolveOptions({
    port: 11500,
    qvacCommand: '/usr/local/bin/qvac',
    configPath: '/tmp/qvac.config.json',
    cwd: '/tmp/project',
    readyTimeoutMs: 123000,
    idleStopMs: 45000
  }))

  assert.equal(provider.baseUrl, 'http://127.0.0.1:11500/v1')
  assert.equal(provider.apiKey, 'qvac-local')
  assert.equal(provider.api, 'openai-completions')
  assert.equal(provider.timeoutSeconds, 300)
  assert.deepEqual(provider.localService, {
    command: '/usr/local/bin/qvac',
    args: [
      'serve',
      'openai',
      '--config',
      '/tmp/qvac.config.json',
      '--host',
      '127.0.0.1',
      '--port',
      '11500',
      '--model',
      'qwen3.5-9b'
    ],
    cwd: '/tmp/project',
    healthUrl: 'http://127.0.0.1:11500/v1/models',
    readyTimeoutMs: 123000,
    idleStopMs: 45000
  })
  assert.equal(provider.models.length, openClawModels.length)
})

test('createQvacServeModels carries serve model guardrails for qvac.config.json generation', () => {
  const models = createQvacServeModels(resolveOptions({
    ctxSize: 65536,
    reasoningBudget: 0,
    tools: false
  }))

  assert.deepEqual(models['qwen3.5-9b'], {
    model: 'QWEN3_5_9B_MULTIMODAL_Q4_K_M',
    preload: true,
    default: true,
    config: {
      ctx_size: 65536,
      reasoning_budget: 0,
      tools: false
    }
  })
})

test('registerQvacProvider registers a catalog provider for OpenClaw', async () => {
  const registered: RegisteredProvider[] = []

  registerQvacProvider({
    registerProvider (provider: RegisteredProvider) {
      registered.push(provider)
    }
  })

  assert.equal(registered.length, 1)
  assert.equal(registered[0]?.id, 'qvac')
  assert.equal(registered[0]?.label, 'QVAC')
  assert.equal(registered[0]?.docsPath, '/providers/qvac')
  assert.deepEqual(registered[0]?.auth, [])

  const catalog = await registered[0]?.catalog.run()
  assert.ok(catalog)
  assert.deepEqual(catalog, { provider: createOpenClawProvider(DEFAULT_OPTIONS) })
})

test('registerQvacProvider reads OpenClaw pluginConfig when present', async () => {
  const registered: RegisteredProvider[] = []
  const api: RegistrationApi = {
    pluginConfig: { model: 'qwen3.5-4b', port: 11500 },
    registerProvider (provider: RegisteredProvider) {
      registered.push(provider)
    }
  }

  registerQvacProvider(api)

  const catalog = await registered[0]?.catalog.run()
  assert.ok(catalog)
  assert.equal((catalog.provider as ReturnType<typeof createOpenClawProvider>).baseUrl, 'http://127.0.0.1:11500/v1')
  assert.deepEqual((catalog.provider as ReturnType<typeof createOpenClawProvider>).localService.args.slice(-1), ['qwen3.5-4b'])
})

test('registerQvacProvider registers static model catalog rows for OpenClaw model listing', () => {
  const registered: RegisteredModelCatalogProvider[] = []

  registerQvacProvider({
    registerProvider () {},
    registerModelCatalogProvider (provider: RegisteredModelCatalogProvider) {
      registered.push(provider)
    }
  })

  assert.equal(registered.length, 1)
  assert.equal(registered[0]?.provider, 'qvac')
  assert.deepEqual(registered[0]?.kinds, ['text'])
  assert.deepEqual(registered[0]?.staticCatalog(), [
    { kind: 'text', provider: 'qvac', model: 'qwen3.5-0.8b', label: 'Qwen3.5 0.8B', source: 'static' },
    { kind: 'text', provider: 'qvac', model: 'qwen3.5-2b', label: 'Qwen3.5 2B', source: 'static' },
    { kind: 'text', provider: 'qvac', model: 'qwen3.5-4b', label: 'Qwen3.5 4B', source: 'static' },
    { kind: 'text', provider: 'qvac', model: 'qwen3.5-9b', label: 'Qwen3.5 9B', source: 'static' }
  ])
})
