import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  qvacCatalog as sharedQvacCatalog,
  resolveModelConstant as resolveSharedModelConstant,
  type QvacCatalogEntry
} from '@qvac/ai-sdk-provider/models'
import type { OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry'

import { ONBOARD_COMMAND_HINT, ensureQvacServe, loadApiKey } from './local-service.js'

// openclaw 2026.8.1 dropped `plugin-sdk/config-types` from its exports map and
// stopped shipping declarations for `plugin-sdk/provider-model-shared`, so the
// two provider-config types are no longer importable by name. Derive them from
// `OpenClawConfig` instead -- it is exported, typed, and already the entry this
// plugin imports `definePluginEntry` from. Deriving rather than re-declaring
// keeps these in step with upstream's real shape, and survives the next
// internal reshuffle of where the types happen to live.
type ModelProviderConfig = NonNullable<NonNullable<OpenClawConfig['models']>['providers']>[string]
type SecretProviderConfig = NonNullable<NonNullable<OpenClawConfig['secrets']>['providers']>[string]

export interface ResolvedOptions {
  readonly model: string
  readonly host: string
  readonly port: number
  readonly apiKeyFile: string
  readonly qvacCommand: string
  readonly cwd: string | undefined
  readonly ctxSize: number
  readonly reasoningBudget: number
  readonly tools: boolean
  readonly readyTimeoutMs: number
  readonly timeoutSeconds: number
}

export type RawOptions = Partial<Record<keyof ResolvedOptions | 'apiKey', unknown>>

export interface OpenClawCost {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface OpenClawModel {
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
  readonly input: Array<'text' | 'image'>
  readonly cost: OpenClawCost
  readonly contextWindow: number
  readonly maxTokens: number
  readonly compat: {
    readonly requiresStringContent: true
  }
}

export interface OpenClawProvider {
  readonly baseUrl: string
  readonly apiKey: QvacApiKeyRef
  readonly api: 'openai-completions'
  readonly timeoutSeconds: number
  readonly models: OpenClawModel[]
}

export interface OpenClawConfigLike {
  readonly agents?: {
    readonly defaults?: {
      readonly experimental?: Record<string, unknown>
      readonly models?: Record<string, {}>
    }
  }
  readonly models?: {
    readonly mode?: OpenClawModelsMode
    readonly providers?: Record<string, ModelProviderConfig>
  }
  readonly secrets?: {
    readonly providers?: Record<string, SecretProviderConfig>
    readonly defaults?: {
      readonly env?: string
      readonly file?: string
      readonly exec?: string
    }
    readonly resolution?: {
      readonly maxProviderConcurrency?: number
      readonly maxRefsPerProvider?: number
      readonly maxBatchBytes?: number
    }
    readonly [key: string]: unknown
  }
}

type OpenClawModelsMode = 'merge' | 'replace'

export interface QvacProviderAuthResult {
  readonly profiles: []
  readonly configPatch: {
    readonly agents: {
      readonly defaults: {
        readonly models: Record<string, {}>
      }
    }
    readonly models: {
      readonly mode: OpenClawModelsMode
      readonly providers: Record<string, ModelProviderConfig>
    }
    readonly secrets: {
      readonly providers: Record<string, SecretProviderConfig>
    }
  }
  readonly defaultModel: string
  readonly notes: string[]
}

export interface OpenClawCatalogRow {
  readonly kind: 'text'
  readonly provider: 'qvac'
  readonly model: string
  readonly label: string
  readonly source: 'static'
}

export interface QvacServeModel {
  readonly model: string
  readonly preload: boolean
  readonly default?: true
  readonly config: {
    readonly ctx_size: number
    readonly reasoning_budget: number
    readonly tools: boolean
  }
}

export interface QvacApiKeyRef {
  readonly source: 'file'
  readonly provider: 'qvac_key_file'
  readonly id: 'value'
}

export interface QvacPreparedRuntimeAuth {
  readonly apiKey: string
  readonly baseUrl: string
}

export interface QvacProviderRegistration {
  readonly pluginConfig?: Record<string, unknown>
  readonly runtime?: {
    readonly state: {
      resolveStateDir(): string
    }
  }
  registerProvider(provider: {
    readonly id: string
    readonly label: string
    readonly docsPath: string
    readonly auth: Array<{
      readonly id: 'local'
      readonly label: 'Local QVAC'
      readonly hint: string
      readonly kind: 'custom'
      run(context: { readonly config: OpenClawConfigLike }): Promise<QvacProviderAuthResult>
      runNonInteractive(context: {
        readonly config: OpenClawConfigLike
      }): Promise<OpenClawConfigLike>
    }>
    prepareRuntimeAuth(context: {
      readonly config?: OpenClawConfigLike
    }): Promise<QvacPreparedRuntimeAuth>
    readonly catalog: {
      readonly order: 'simple'
      run(): Promise<{ provider: OpenClawProvider }>
    }
    readonly staticCatalog: {
      readonly order: 'simple'
      run(): Promise<{ provider: OpenClawProvider }>
    }
    readonly wizard: {
      readonly setup: {
        readonly choiceId: 'qvac'
        readonly choiceLabel: 'QVAC'
        readonly choiceHint: string
        readonly groupId: 'qvac'
        readonly groupLabel: 'QVAC'
        readonly groupHint: string
        readonly methodId: 'local'
      }
      readonly modelPicker: {
        readonly label: 'QVAC'
        readonly hint: string
        readonly methodId: 'local'
      }
    }
  }): void
  registerModelCatalogProvider?(provider: {
    readonly provider: 'qvac'
    readonly kinds: readonly ['text']
    staticCatalog(): readonly OpenClawCatalogRow[]
  }): void
}

const QVAC_SECRET_PROVIDER_ID = 'qvac_key_file'

export function resolveQvacApiKeyFile(stateDir: string): string {
  return join(stateDir, 'plugins', 'qvac', 'api-key')
}

function resolveFallbackOpenClawStateDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const override = env['OPENCLAW_STATE_DIR']?.trim()
  if (override) {
    if (override === '~') return home
    if (override.startsWith('~/')) return join(home, override.slice(2))
    return resolve(override)
  }

  const current = join(home, '.openclaw')
  if (existsSync(current)) return current
  const legacy = join(home, '.clawdbot')
  return existsSync(legacy) ? legacy : current
}

// The configured URL never carries traffic: `prepareRuntimeAuth` swaps in the
// port the plugin's own serve reported. `.invalid` cannot resolve, so a request
// that skips that hook fails instead of reaching whoever holds a loopback port,
// and OpenClaw's unauthenticated local-endpoint preflight leaves it alone.
export const UNVERIFIED_BASE_URL = 'http://qvac.invalid/v1'

export const DEFAULT_OPTIONS: ResolvedOptions = {
  model: 'qwen3.5-9b',
  host: '127.0.0.1',
  port: 0,
  apiKeyFile: resolveQvacApiKeyFile(resolveFallbackOpenClawStateDir()),
  qvacCommand: 'qvac',
  cwd: undefined,
  ctxSize: 32768,
  reasoningBudget: -1,
  tools: true,
  readyTimeoutMs: 180_000,
  timeoutSeconds: 300
}

const ZERO_COST: OpenClawCost = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const OPENCLAW_CATALOG_OVERLAY: readonly QvacCatalogEntry[] = [
  { id: 'qwen3.6-27b', constant: 'QWEN3_6_27B_MULTIMODAL_Q4_K_XL', name: 'Qwen3.6 27B' },
  { id: 'qwen3.6-35b-a3b', constant: 'QWEN3_6_35B_A3B_MULTIMODAL_Q4_K_M', name: 'Qwen3.6 35B A3B' },
  { id: 'gpt-oss-20b', constant: 'GPT_OSS_20B_INST_Q4_K_M', name: 'GPT-OSS 20B' },
  { id: 'gemma4-31b', constant: 'GEMMA4_31B_MULTIMODAL_Q4_K_M', name: 'Gemma4 31B' }
]

function createOpenClawCatalog(): readonly QvacCatalogEntry[] {
  const seen = new Set(sharedQvacCatalog.map((entry) => entry.id))
  const entries: QvacCatalogEntry[] = [...sharedQvacCatalog]
  for (const entry of OPENCLAW_CATALOG_OVERLAY) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}

const openClawCatalog = createOpenClawCatalog()
const openClawCatalogById = new Map(openClawCatalog.map((entry) => [entry.id, entry]))
const openClawCatalogByConstant = new Map(openClawCatalog.map((entry) => [entry.constant, entry]))

function resolveOpenClawModelConstant(idOrConstant: string): string {
  return (
    openClawCatalogById.get(idOrConstant)?.constant ??
    openClawCatalogByConstant.get(idOrConstant)?.constant ??
    resolveSharedModelConstant(idOrConstant)
  )
}

export function createOpenClawModels(options: ResolvedOptions): OpenClawModel[] {
  return openClawCatalog.map((entry) => ({
    id: entry.id,
    name: entry.name,
    reasoning: true,
    input: entry.constant.includes('MULTIMODAL') ? ['text', 'image'] : ['text'],
    cost: ZERO_COST,
    contextWindow: options.ctxSize,
    maxTokens: 8192,
    compat: { requiresStringContent: true }
  }))
}

export const openClawModels: OpenClawModel[] = createOpenClawModels(DEFAULT_OPTIONS)

export const openClawCatalogRows: readonly OpenClawCatalogRow[] = openClawCatalog.map((entry) => ({
  kind: 'text',
  provider: 'qvac',
  model: entry.id,
  label: entry.name,
  source: 'static'
}))

function resolveOpenClawModelsMode(mode: string | undefined): OpenClawModelsMode {
  return mode === 'replace' ? 'replace' : 'merge'
}

function coerceString(option: string, value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`${option} must be a string`)
  return value
}

export function normalizeApiKey(value: unknown, option: string): string {
  const normalized = coerceString(option, value).trim()
  if (
    normalized.length < 32 ||
    normalized.length > 128 ||
    normalized.startsWith('-') ||
    !/^[A-Za-z0-9_-]+$/.test(normalized)
  ) {
    throw new TypeError(`${option} must be 32-128 base64url characters and cannot start with "-"`)
  }
  return normalized
}

// base64url includes `-`, and `normalizeApiKey` rejects a leading one so a
// stored key can never be mistaken for a CLI flag. A raw draw therefore fails
// its own validator about once in 64. Redrawing keeps every position uniform;
// rewriting the first character would bias it and shrink the keyspace.
export function generateApiKey(): string {
  for (;;) {
    const candidate = randomBytes(32).toString('base64url')
    if (!candidate.startsWith('-')) return candidate
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

function assertRegularKeyFile(keyFile: string): void {
  try {
    if (!lstatSync(keyFile).isFile()) {
      throw new TypeError(`QVAC API key path must be a regular file: ${keyFile}`)
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
}

function restrictExistingKeyFile(keyFile: string): void {
  try {
    chmodSync(keyFile, 0o600)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
}

function writePrivateKeyFile(keyFile: string, apiKey: string, exclusive: boolean): void {
  const descriptor = openSync(keyFile, exclusive ? 'wx' : 'w', 0o600)
  try {
    writeFileSync(descriptor, apiKey, 'utf8')
  } finally {
    closeSync(descriptor)
  }
  chmodSync(keyFile, 0o600)
}

export function ensureApiKeyFile(keyFile: string, configuredApiKey?: string): string {
  const keyDir = dirname(keyFile)
  mkdirSync(keyDir, { recursive: true, mode: 0o700 })
  chmodSync(keyDir, 0o700)
  assertRegularKeyFile(keyFile)
  restrictExistingKeyFile(keyFile)

  if (configuredApiKey !== undefined) {
    const normalized = normalizeApiKey(configuredApiKey, 'apiKey')
    writePrivateKeyFile(keyFile, normalized, false)
    return normalized
  }

  try {
    const raw = readFileSync(keyFile, 'utf8')
    const normalized = normalizeApiKey(raw, 'stored QVAC API key')
    if (raw !== normalized) writePrivateKeyFile(keyFile, normalized, false)
    return normalized
  } catch (error) {
    // A stored key that no longer parses is unusable, and it is a locally
    // generated secret with no external copy — so re-onboarding replaces it in
    // place (over the already-validated regular-file path) instead of leaving the
    // user to delete the file by hand. Read failures (EACCES, …) still propagate.
    if (error instanceof TypeError) {
      const replacement = generateApiKey()
      writePrivateKeyFile(keyFile, replacement, false)
      return replacement
    }
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }

  const generated = generateApiKey()
  try {
    writePrivateKeyFile(keyFile, generated, true)
    return generated
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
    return ensureApiKeyFile(keyFile)
  }
}

function coerceNumber(option: string, value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new TypeError(`${option} must be a finite number`)
  return n
}

function coerceBoolean(option: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new TypeError(`${option} must be a boolean`)
}

function resolveOptionsWithApiKey(raw: RawOptions): {
  options: ResolvedOptions
  configuredApiKey: string | undefined
} {
  return {
    configuredApiKey: raw.apiKey === undefined ? undefined : normalizeApiKey(raw.apiKey, 'apiKey'),
    options: {
      model: raw.model === undefined ? DEFAULT_OPTIONS.model : coerceString('model', raw.model),
      host: raw.host === undefined ? DEFAULT_OPTIONS.host : coerceString('host', raw.host),
      port: raw.port === undefined ? DEFAULT_OPTIONS.port : coerceNumber('port', raw.port),
      apiKeyFile:
        raw.apiKeyFile === undefined
          ? DEFAULT_OPTIONS.apiKeyFile
          : coerceString('apiKeyFile', raw.apiKeyFile),
      qvacCommand:
        raw.qvacCommand === undefined
          ? DEFAULT_OPTIONS.qvacCommand
          : coerceString('qvacCommand', raw.qvacCommand),
      cwd: raw.cwd === undefined ? DEFAULT_OPTIONS.cwd : coerceString('cwd', raw.cwd),
      ctxSize:
        raw.ctxSize === undefined ? DEFAULT_OPTIONS.ctxSize : coerceNumber('ctxSize', raw.ctxSize),
      reasoningBudget:
        raw.reasoningBudget === undefined
          ? DEFAULT_OPTIONS.reasoningBudget
          : coerceNumber('reasoningBudget', raw.reasoningBudget),
      tools: raw.tools === undefined ? DEFAULT_OPTIONS.tools : coerceBoolean('tools', raw.tools),
      readyTimeoutMs:
        raw.readyTimeoutMs === undefined
          ? DEFAULT_OPTIONS.readyTimeoutMs
          : coerceNumber('readyTimeoutMs', raw.readyTimeoutMs),
      timeoutSeconds:
        raw.timeoutSeconds === undefined
          ? DEFAULT_OPTIONS.timeoutSeconds
          : coerceNumber('timeoutSeconds', raw.timeoutSeconds)
    }
  }
}

export function resolveOptions(raw: RawOptions = {}): ResolvedOptions {
  return resolveOptionsWithApiKey(raw).options
}

function prepareOptions(raw: RawOptions): ResolvedOptions {
  const { options, configuredApiKey } = resolveOptionsWithApiKey(raw)
  ensureApiKeyFile(options.apiKeyFile, configuredApiKey)
  return options
}

export function createQvacServeModels(options: ResolvedOptions): Record<string, QvacServeModel> {
  const models: Record<string, QvacServeModel> = {}
  for (const entry of openClawCatalog) {
    models[entry.id] = {
      model: resolveOpenClawModelConstant(entry.id),
      preload: entry.id === options.model,
      ...(entry.id === options.model ? { default: true as const } : {}),
      config: {
        ctx_size: options.ctxSize,
        reasoning_budget: options.reasoningBudget,
        tools: options.tools
      }
    }
  }
  return models
}

export function createOpenClawProvider(options: ResolvedOptions): OpenClawProvider {
  return {
    baseUrl: UNVERIFIED_BASE_URL,
    apiKey: {
      source: 'file',
      provider: QVAC_SECRET_PROVIDER_ID,
      id: 'value'
    },
    api: 'openai-completions',
    timeoutSeconds: options.timeoutSeconds,
    models: createOpenClawModels(options)
  }
}

// An entry onboarded by an earlier plugin version still declares OpenClaw's
// `localService`, whose health probe sends the key to the fixed port before
// anything is spawned. Refuse it rather than run alongside that probe.
function assertNoLegacyLocalService(config: OpenClawConfigLike | undefined): void {
  const provider = config?.models?.providers?.['qvac'] as Record<string, unknown> | undefined
  if (provider?.['localService'] === undefined) return
  throw new TypeError(
    'This QVAC provider entry was created by an older plugin version that let OpenClaw start ' +
      'qvac serve on a fixed port. Re-run ' +
      ONBOARD_COMMAND_HINT +
      ' to regenerate it.'
  )
}

export async function prepareQvacRuntimeAuth(
  config: OpenClawConfigLike | undefined,
  rawOptions: RawOptions
): Promise<QvacPreparedRuntimeAuth> {
  assertNoLegacyLocalService(config)
  const options = prepareOptions(rawOptions)
  const apiKey = loadApiKey(options.apiKeyFile)
  const serve = await ensureQvacServe({
    qvacCommand: options.qvacCommand,
    apiKeyFile: options.apiKeyFile,
    model: options.model,
    host: options.host,
    port: options.port,
    cwd: options.cwd,
    ctxSize: options.ctxSize,
    reasoningBudget: options.reasoningBudget,
    tools: options.tools,
    readyTimeoutMs: options.readyTimeoutMs
  })
  return { apiKey, baseUrl: serve.baseUrl }
}

export function createQvacSetupResult(
  config: OpenClawConfigLike,
  rawOptions: RawOptions = {}
): QvacProviderAuthResult {
  const options = prepareOptions(rawOptions)
  const defaultModel = `qvac/${options.model}`
  return {
    profiles: [],
    configPatch: {
      agents: {
        defaults: {
          models: {
            ...config.agents?.defaults?.models,
            [defaultModel]: {}
          }
        }
      },
      models: {
        mode: resolveOpenClawModelsMode(config.models?.mode),
        providers: {
          ...config.models?.providers,
          qvac: createOpenClawProvider(options)
        }
      },
      secrets: {
        providers: {
          ...config.secrets?.providers,
          [QVAC_SECRET_PROVIDER_ID]: {
            source: 'file',
            path: options.apiKeyFile,
            mode: 'singleValue'
          }
        }
      }
    },
    defaultModel,
    notes: ['Configured QVAC as a local OpenAI-compatible provider.']
  }
}

export function applyQvacSetupConfig(
  config: OpenClawConfigLike,
  rawOptions: RawOptions = {}
): OpenClawConfigLike {
  const setup = createQvacSetupResult(config, rawOptions).configPatch
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        models: setup.agents.defaults.models
      }
    },
    models: {
      ...config.models,
      mode: setup.models.mode,
      providers: setup.models.providers
    },
    secrets: {
      ...config.secrets,
      providers: setup.secrets.providers
    }
  }
}

export function registerQvacProvider(
  api: QvacProviderRegistration,
  rawOptions: RawOptions = {}
): void {
  const pluginConfig = api.pluginConfig ?? {}
  const stateDir = api.runtime?.state.resolveStateDir() ?? resolveFallbackOpenClawStateDir()
  const apiKeyFile = resolveQvacApiKeyFile(stateDir)
  const mergedOptions = () => ({
    apiKeyFile,
    ...pluginConfig,
    ...rawOptions
  })
  api.registerModelCatalogProvider?.({
    provider: 'qvac',
    kinds: ['text'],
    staticCatalog: () => openClawCatalogRows
  })

  const providerConfig = () => createOpenClawProvider(resolveOptions(mergedOptions()))

  api.registerProvider({
    id: 'qvac',
    label: 'QVAC',
    docsPath: '/providers/qvac',
    auth: [
      {
        id: 'local',
        label: 'Local QVAC',
        hint: 'Start a local qvac serve',
        kind: 'custom',
        // lunte-disable-next-line require-await
        run: async ({ config }) => createQvacSetupResult(config, mergedOptions()),
        // lunte-disable-next-line require-await
        runNonInteractive: async ({ config }) => applyQvacSetupConfig(config, mergedOptions())
      }
    ],
    prepareRuntimeAuth: ({ config }) => prepareQvacRuntimeAuth(config, mergedOptions()),
    catalog: {
      order: 'simple',
      // lunte-disable-next-line require-await
      run: async () => ({ provider: providerConfig() })
    },
    staticCatalog: {
      order: 'simple',
      // lunte-disable-next-line require-await
      run: async () => ({ provider: providerConfig() })
    },
    wizard: {
      setup: {
        choiceId: 'qvac',
        choiceLabel: 'QVAC',
        choiceHint: 'Local qvac serve runtime',
        groupId: 'qvac',
        groupLabel: 'QVAC',
        groupHint: 'Local-first QVAC models',
        methodId: 'local'
      },
      modelPicker: {
        label: 'QVAC',
        hint: 'Use the QVAC model catalog',
        methodId: 'local'
      }
    }
  })
}
