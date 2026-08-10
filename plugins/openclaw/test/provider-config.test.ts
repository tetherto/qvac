import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadApiKey } from '../src/local-service.ts'
import type { OpenClawProvider, QvacProviderAuthResult } from '../src/provider-config.ts'
import {
  DEFAULT_OPTIONS,
  applyQvacSetupConfig,
  createOpenClawModels,
  createOpenClawProvider,
  createQvacServeModels,
  createQvacSetupResult,
  ensureApiKeyFile,
  normalizeApiKey,
  openClawModels,
  registerQvacProvider,
  resolveOptions
} from '../src/provider-config.ts'

const TEST_KEY = 'abcdefghijklmnopqrstuvwxyzABCDE_'
const TEST_KEY_FILE = '/tmp/qvac-openclaw/api-key'

interface RegisteredAuthMethod {
  readonly id: string
  readonly kind: string
  run(context: { readonly config: {} }): Promise<QvacProviderAuthResult>
}

interface RegisteredProvider {
  readonly id: string
  readonly label: string
  readonly docsPath: string
  readonly auth: RegisteredAuthMethod[]
  resolveSyntheticAuth?(context: {
    readonly provider: string
    readonly providerConfig?: unknown
  }): unknown
  shouldDeferSyntheticProfileAuth?(context: {
    readonly resolvedApiKey?: string
  }): boolean | undefined
  readonly catalog: {
    readonly order: string
    run(): Promise<{ provider: unknown }>
  }
  readonly staticCatalog: {
    readonly order: string
    run(): Promise<{ provider: unknown }>
  }
}

interface RegistrationApi {
  readonly pluginConfig?: Record<string, unknown>
  readonly runtime?: {
    readonly state: {
      resolveStateDir(): string
    }
  }
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
  assert.equal(options.serviceRuntime, process.execPath)
  assert.match(options.serviceEntrypoint, /local-service\.js$/)
})

test('openClawModels maps the shared QVAC catalog into OpenClaw model rows', () => {
  const model = openClawModels.find((entry) => entry.id === 'qwen3.5-9b')
  const gptOss = openClawModels.find((entry) => entry.id === 'gpt-oss-20b')

  assert.ok(model)
  assert.equal(model.name, 'Qwen3.5 9B')
  assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.reasoning, true)
  assert.equal(model.contextWindow, 32768)
  assert.equal(model.maxTokens, 8192)
  assert.deepEqual(model.compat, { requiresStringContent: true })
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

  assert.ok(gptOss)
  assert.equal(gptOss.name, 'GPT-OSS 20B')
  assert.deepEqual(gptOss.input, ['text'])
  assert.equal(gptOss.reasoning, true)
})

test('createOpenClawModels advertises the configured context window', () => {
  const model = createOpenClawModels(resolveOptions({ ctxSize: 65536 })).find(
    (entry) => entry.id === 'qwen3.5-9b'
  )

  assert.ok(model)
  assert.equal(model.contextWindow, 65536)
})

test('createOpenClawProvider builds a localService-backed OpenAI-compatible provider', () => {
  const provider = createOpenClawProvider(
    resolveOptions({
      port: 11500,
      apiKey: TEST_KEY,
      apiKeyFile: TEST_KEY_FILE,
      qvacCommand: '/usr/local/bin/qvac',
      serviceRuntime: '/usr/local/bin/node',
      serviceEntrypoint: '/tmp/qvac-openclaw-local-service.js',
      cwd: '/tmp/project',
      ctxSize: 65536,
      readyTimeoutMs: 123000,
      idleStopMs: 45000
    })
  )

  assert.equal(provider.baseUrl, 'http://127.0.0.1:11500/v1')
  assert.deepEqual(provider.apiKey, {
    source: 'file',
    provider: 'qvac_key_file',
    id: 'value'
  })
  assert.equal(provider.api, 'openai-completions')
  assert.equal(provider.timeoutSeconds, 300)
  assert.deepEqual(provider.localService, {
    command: '/usr/local/bin/node',
    args: [
      '/tmp/qvac-openclaw-local-service.js',
      '--qvac-command',
      '/usr/local/bin/qvac',
      '--api-key-file',
      TEST_KEY_FILE,
      '--model',
      'qwen3.5-9b',
      '--host',
      '127.0.0.1',
      '--port',
      '11500',
      '--ctx-size',
      '65536',
      '--reasoning-budget',
      '-1',
      '--tools',
      'true'
    ],
    cwd: '/tmp/project',
    healthUrl: 'http://127.0.0.1:11500/v1/models',
    readyTimeoutMs: 123000,
    idleStopMs: 45000
  })
  assert.equal(provider.models.length, openClawModels.length)
  assert.equal(provider.models.find((entry) => entry.id === 'qwen3.5-9b')?.contextWindow, 65536)
})

test('resolveOptions rejects an empty configured API key', () => {
  assert.throws(() => resolveOptions({ apiKey: '' }), /apiKey must be 32-128 base64url characters/)
})

test('API keys are normalized to a conservative base64url form', () => {
  assert.equal(normalizeApiKey(`  ${TEST_KEY}\n`, 'apiKey'), TEST_KEY)
  for (const value of [
    'short',
    'abcdefghijklmnopqrstuvwxyzABCDE!',
    'abcdefghijklmnopqrstuvwxyzABCD🙂',
    'abcdefghijklmnopqrstuvwxyzABCD\u0000',
    '--modelabcdefghijklmnopqrstuvwxyz'
  ]) {
    assert.throws(() => normalizeApiKey(value, 'apiKey'), /32-128 base64url characters/)
  }
})

test('API key file is generated once, reused, and permission-hardened', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-state-test-'))
  const keyFile = join(stateDir, 'plugins', 'qvac', 'api-key')

  const first = ensureApiKeyFile(keyFile)
  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(ensureApiKeyFile(keyFile), first)
  assert.equal(statSync(join(stateDir, 'plugins', 'qvac')).mode & 0o777, 0o700)
  assert.equal(statSync(keyFile).mode & 0o777, 0o600)

  writeFileSync(keyFile, `${TEST_KEY}\n`, { mode: 0o644 })
  chmodSync(join(stateDir, 'plugins', 'qvac'), 0o755)
  chmodSync(keyFile, 0o644)
  assert.equal(ensureApiKeyFile(keyFile), TEST_KEY)
  assert.equal(readFileSync(keyFile, 'utf8'), TEST_KEY)
  assert.equal(statSync(join(stateDir, 'plugins', 'qvac')).mode & 0o777, 0o700)
  assert.equal(statSync(keyFile).mode & 0o777, 0o600)
  rmSync(stateDir, { recursive: true })
})

test('re-onboarding regenerates a corrupt key file in place', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-state-test-'))
  const keyFile = join(stateDir, 'plugins', 'qvac', 'api-key')

  // Materialize the directory tree with a healthy key first.
  ensureApiKeyFile(keyFile)

  // The key is locally generated and has no external copy, so an unusable one
  // can be replaced instead of demanding a manual delete.
  for (const corrupt of [
    '',
    '   \n',
    'short',
    'abcdefghijklmnopqrstuvwxyzABCD🙂',
    '-abcdefghijklmnopqrstuvwxyzABCDE'
  ]) {
    writeFileSync(keyFile, corrupt)
    const regenerated = ensureApiKeyFile(keyFile)
    assert.match(regenerated, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(readFileSync(keyFile, 'utf8'), regenerated)
    assert.equal(statSync(keyFile).mode & 0o777, 0o600)
    // Stable once healthy again.
    assert.equal(ensureApiKeyFile(keyFile), regenerated)
  }

  rmSync(stateDir, { recursive: true })
})

test('a key path that is not a regular file is rejected rather than overwritten', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-state-test-'))
  const keyFile = join(stateDir, 'plugins', 'qvac', 'api-key')
  ensureApiKeyFile(keyFile)
  rmSync(keyFile)
  const target = join(stateDir, 'elsewhere')
  writeFileSync(target, 'not-a-key')
  symlinkSync(target, keyFile)

  assert.throws(() => ensureApiKeyFile(keyFile), /must be a regular file/)
  assert.equal(readFileSync(target, 'utf8'), 'not-a-key')

  rmSync(stateDir, { recursive: true })
})

test('configured API key is materialized into the private key file', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-state-test-'))
  const keyFile = join(stateDir, 'plugins', 'qvac', 'api-key')

  assert.equal(ensureApiKeyFile(keyFile, ` ${TEST_KEY}\n`), TEST_KEY)
  assert.equal(readFileSync(keyFile, 'utf8'), TEST_KEY)
  assert.equal(statSync(keyFile).mode & 0o777, 0o600)
  rmSync(stateDir, { recursive: true })
})

test('createQvacSetupResult materializes provider config without pasted JSON', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-state-test-'))
  const keyFile = join(stateDir, 'plugins', 'qvac', 'api-key')
  const openAiProvider = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'OPENAI_API_KEY',
    models: []
  }
  const result = createQvacSetupResult(
    {
      agents: { defaults: { models: { 'openai/gpt-4.1': {} } } },
      models: { mode: 'merge', providers: { openai: openAiProvider } }
    },
    {
      port: 11500,
      apiKeyFile: keyFile,
      qvacCommand: '/usr/local/bin/qvac'
    }
  )

  assert.equal(result.defaultModel, 'qvac/qwen3.5-9b')
  assert.deepEqual(result.profiles, [])
  assert.deepEqual(result.notes, ['Configured QVAC as a local OpenAI-compatible provider.'])
  assert.deepEqual(result.configPatch.agents.defaults.models, {
    'openai/gpt-4.1': {},
    'qvac/qwen3.5-9b': {}
  })
  assert.equal(Object.hasOwn(result.configPatch.agents.defaults, 'experimental'), false)
  assert.equal(result.configPatch.models.mode, 'merge')
  assert.deepEqual(result.configPatch.secrets, {
    providers: {
      qvac_key_file: {
        source: 'file',
        path: keyFile,
        mode: 'singleValue'
      }
    }
  })
  assert.deepEqual(Object.keys(result.configPatch.models.providers).sort(), ['openai', 'qvac'])
  assert.deepEqual(
    result.configPatch.models.providers['qvac'],
    createOpenClawProvider(
      resolveOptions({
        port: 11500,
        apiKeyFile: keyFile,
        qvacCommand: '/usr/local/bin/qvac'
      })
    )
  )
  const qvacProvider = result.configPatch.models.providers['qvac'] as OpenClawProvider
  const generatedKey = readFileSync(keyFile, 'utf8')
  assert.deepEqual(qvacProvider.apiKey, {
    source: 'file',
    provider: 'qvac_key_file',
    id: 'value'
  })
  const qvacSecretProvider = result.configPatch.secrets.providers[qvacProvider.apiKey.provider]
  assert.equal(qvacSecretProvider?.source, 'file')
  if (qvacSecretProvider?.source !== 'file') assert.fail('QVAC file secret provider is missing')
  assert.deepEqual(
    qvacProvider.localService.args.slice(
      qvacProvider.localService.args.indexOf('--api-key-file'),
      qvacProvider.localService.args.indexOf('--api-key-file') + 2
    ),
    ['--api-key-file', keyFile]
  )
  assert.equal(qvacSecretProvider.path, keyFile)
  assert.equal(loadApiKey(qvacSecretProvider.path), generatedKey)
  assert.equal(JSON.stringify(qvacProvider).includes(generatedKey), false)
  rmSync(stateDir, { recursive: true })
})

test('applyQvacSetupConfig preserves existing OpenClaw settings', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-state-test-'))
  const keyFile = join(stateDir, 'plugins', 'qvac', 'api-key')
  const config = applyQvacSetupConfig(
    {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
            futureOpenClawFlag: 'preserve-me'
          }
        }
      },
      secrets: {
        providers: {
          qvac: {
            source: 'env',
            allowlist: ['UNRELATED_QVAC_KEY']
          }
        },
        defaults: {
          env: 'default',
          file: 'existing_file_provider'
        },
        resolution: {
          maxProviderConcurrency: 2
        },
        futureSecretSetting: {
          preserve: true
        }
      }
    },
    { model: 'qwen3.5-4b', apiKeyFile: keyFile }
  )

  assert.deepEqual(config.agents?.defaults?.models, { 'qvac/qwen3.5-4b': {} })
  assert.deepEqual(config.agents?.defaults?.experimental, {
    localModelLean: true,
    futureOpenClawFlag: 'preserve-me'
  })
  assert.equal(config.models?.mode, 'merge')
  assert.deepEqual(
    config.models?.providers?.['qvac'],
    createOpenClawProvider(resolveOptions({ model: 'qwen3.5-4b', apiKeyFile: keyFile }))
  )
  assert.deepEqual(config.secrets?.providers?.['qvac'], {
    source: 'env',
    allowlist: ['UNRELATED_QVAC_KEY']
  })
  assert.deepEqual(config.secrets?.providers?.['qvac_key_file'], {
    source: 'file',
    path: keyFile,
    mode: 'singleValue'
  })
  assert.deepEqual(config.secrets?.defaults, {
    env: 'default',
    file: 'existing_file_provider'
  })
  assert.deepEqual(config.secrets?.resolution, {
    maxProviderConcurrency: 2
  })
  assert.deepEqual(config.secrets?.['futureSecretSetting'], {
    preserve: true
  })
  rmSync(stateDir, { recursive: true })
})

test('createQvacServeModels carries serve model guardrails for qvac.config.json generation', () => {
  const models = createQvacServeModels(
    resolveOptions({
      model: 'gpt-oss-20b',
      ctxSize: 65536,
      reasoningBudget: 0,
      tools: false
    })
  )

  assert.deepEqual(models['gpt-oss-20b'], {
    model: 'GPT_OSS_20B_INST_Q4_K_M',
    preload: true,
    default: true,
    config: {
      ctx_size: 65536,
      reasoning_budget: 0,
      tools: false
    }
  })
  assert.equal(models['qwen3.5-9b']?.default, undefined)
})

test('registerQvacProvider registers a catalog provider for OpenClaw', async () => {
  const registered: RegisteredProvider[] = []
  const stateDir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-state-test-'))
  const keyFile = join(stateDir, 'plugins', 'qvac', 'api-key')

  registerQvacProvider(
    {
      registerProvider(provider: RegisteredProvider) {
        registered.push(provider)
      }
    },
    { apiKeyFile: keyFile }
  )

  assert.equal(registered.length, 1)
  assert.equal(registered[0]?.id, 'qvac')
  assert.equal(registered[0]?.label, 'QVAC')
  assert.equal(registered[0]?.docsPath, '/providers/qvac')
  assert.equal(registered[0]?.auth.length, 1)
  assert.equal(registered[0]?.auth[0]?.id, 'local')
  assert.equal(registered[0]?.auth[0]?.kind, 'custom')
  assert.equal(registered[0]?.resolveSyntheticAuth, undefined)
  assert.equal(registered[0]?.shouldDeferSyntheticProfileAuth, undefined)

  const catalog = await registered[0]?.catalog.run()
  assert.ok(catalog)
  const expectedOptions = resolveOptions({ apiKeyFile: keyFile })
  assert.deepEqual(catalog, { provider: createOpenClawProvider(expectedOptions) })
  assert.equal(existsSync(keyFile), false)

  const staticCatalog = await registered[0]?.staticCatalog.run()
  assert.ok(staticCatalog)
  assert.deepEqual(staticCatalog, { provider: createOpenClawProvider(expectedOptions) })
  assert.equal(existsSync(keyFile), false)

  const setup = await registered[0]?.auth[0]?.run({ config: {} })
  assert.ok(setup)
  assert.equal(existsSync(keyFile), true)
  assert.deepEqual(
    setup.configPatch.models.providers['qvac'],
    createOpenClawProvider(expectedOptions)
  )
  assert.deepEqual(setup.configPatch.agents.defaults.models, { 'qvac/qwen3.5-9b': {} })
  rmSync(stateDir, { recursive: true })
})

test('registerQvacProvider reads OpenClaw pluginConfig when present', async () => {
  const registered: RegisteredProvider[] = []
  const stateDir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-state-test-'))
  const keyFile = join(stateDir, 'plugins', 'qvac', 'api-key')
  const api: RegistrationApi = {
    pluginConfig: { model: 'qwen3.5-4b', port: 11500, apiKey: ` ${TEST_KEY}\n` },
    registerProvider(provider: RegisteredProvider) {
      registered.push(provider)
    }
  }

  registerQvacProvider(api, { apiKeyFile: keyFile })

  const catalog = await registered[0]?.catalog.run()
  assert.ok(catalog)
  assert.equal(
    (catalog.provider as ReturnType<typeof createOpenClawProvider>).baseUrl,
    'http://127.0.0.1:11500/v1'
  )
  const args = (catalog.provider as ReturnType<typeof createOpenClawProvider>).localService.args
  assert.deepEqual(args.slice(args.indexOf('--api-key-file'), args.indexOf('--api-key-file') + 2), [
    '--api-key-file',
    keyFile
  ])
  assert.equal(args.includes(TEST_KEY), false)
  assert.equal(existsSync(keyFile), false)
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), [
    '--model',
    'qwen3.5-4b'
  ])
  const setup = await registered[0]?.auth[0]?.run({ config: {} })
  assert.ok(setup)
  assert.equal(readFileSync(keyFile, 'utf8'), TEST_KEY)
  rmSync(stateDir, { recursive: true })
})

test('registerQvacProvider derives the key path from the OpenClaw runtime state', async () => {
  const registered: RegisteredProvider[] = []
  const stateDir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-runtime-state-test-'))
  const expectedKeyFile = join(stateDir, 'plugins', 'qvac', 'api-key')

  registerQvacProvider({
    runtime: {
      state: {
        resolveStateDir() {
          return stateDir
        }
      }
    },
    registerProvider(provider: RegisteredProvider) {
      registered.push(provider)
    }
  })

  const catalog = await registered[0]?.catalog.run()
  assert.ok(catalog)
  const provider = catalog.provider as OpenClawProvider
  const keyFileIndex = provider.localService.args.indexOf('--api-key-file')
  assert.equal(provider.localService.args[keyFileIndex + 1], expectedKeyFile)
  assert.equal(existsSync(expectedKeyFile), false)
  rmSync(stateDir, { recursive: true })
})

test('registerQvacProvider registers static model catalog rows for OpenClaw model listing', () => {
  const registered: RegisteredModelCatalogProvider[] = []

  registerQvacProvider({
    registerProvider() {},
    registerModelCatalogProvider(provider: RegisteredModelCatalogProvider) {
      registered.push(provider)
    }
  })

  assert.equal(registered.length, 1)
  assert.equal(registered[0]?.provider, 'qvac')
  assert.deepEqual(registered[0]?.kinds, ['text'])
  assert.deepEqual(registered[0]?.staticCatalog(), [
    {
      kind: 'text',
      provider: 'qvac',
      model: 'qwen3.5-0.8b',
      label: 'Qwen3.5 0.8B',
      source: 'static'
    },
    { kind: 'text', provider: 'qvac', model: 'qwen3.5-2b', label: 'Qwen3.5 2B', source: 'static' },
    { kind: 'text', provider: 'qvac', model: 'qwen3.5-4b', label: 'Qwen3.5 4B', source: 'static' },
    { kind: 'text', provider: 'qvac', model: 'qwen3.5-9b', label: 'Qwen3.5 9B', source: 'static' },
    {
      kind: 'text',
      provider: 'qvac',
      model: 'qwen3.6-27b',
      label: 'Qwen3.6 27B',
      source: 'static'
    },
    {
      kind: 'text',
      provider: 'qvac',
      model: 'qwen3.6-35b-a3b',
      label: 'Qwen3.6 35B A3B',
      source: 'static'
    },
    {
      kind: 'text',
      provider: 'qvac',
      model: 'gpt-oss-20b',
      label: 'GPT-OSS 20B',
      source: 'static'
    },
    { kind: 'text', provider: 'qvac', model: 'gemma4-31b', label: 'Gemma4 31B', source: 'static' }
  ])
})
