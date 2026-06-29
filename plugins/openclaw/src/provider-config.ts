import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { qvacCatalog, resolveModelConstant } from '@qvac/ai-sdk-provider/models'
import type { ModelProviderConfig } from 'openclaw/plugin-sdk/provider-model-shared'

export interface ResolvedOptions {
  readonly model: string
  readonly host: string
  readonly port: number
  readonly baseUrl: string
  readonly apiKey: string
  readonly qvacCommand: string
  readonly serviceRuntime: string
  readonly serviceEntrypoint: string
  readonly cwd: string | undefined
  readonly ctxSize: number
  readonly reasoningBudget: number
  readonly tools: boolean
  readonly readyTimeoutMs: number
  readonly idleStopMs: number
  readonly timeoutSeconds: number
}

export type RawOptions = Partial<Record<keyof ResolvedOptions, unknown>>

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

export interface OpenClawLocalService {
  readonly command: string
  readonly args: string[]
  readonly cwd?: string
  readonly healthUrl: string
  readonly readyTimeoutMs: number
  readonly idleStopMs: number
}

export interface OpenClawProvider {
  readonly baseUrl: string
  readonly apiKey: string
  readonly api: 'openai-completions'
  readonly timeoutSeconds: number
  readonly localService: OpenClawLocalService
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
}

type OpenClawModelsMode = 'merge' | 'replace'

export interface QvacProviderAuthResult {
  readonly profiles: []
  readonly configPatch: {
    readonly agents: {
      readonly defaults: {
        readonly experimental: Record<string, unknown>
        readonly models: Record<string, {}>
      }
    }
    readonly models: {
      readonly mode: OpenClawModelsMode
      readonly providers: Record<string, ModelProviderConfig>
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

export interface QvacProviderRegistration {
  readonly pluginConfig?: Record<string, unknown>
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
      runNonInteractive(context: { readonly config: OpenClawConfigLike }): Promise<OpenClawConfigLike>
    }>
    resolveSyntheticAuth(context: {
      readonly provider: string
      readonly providerConfig?: unknown
    }): {
      readonly apiKey: 'custom-local'
      readonly source: string
      readonly mode: 'api-key'
    }
    shouldDeferSyntheticProfileAuth(context: { readonly resolvedApiKey?: string }): boolean | undefined
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

export const DEFAULT_OPTIONS: ResolvedOptions = {
  model: 'qwen3.5-9b',
  host: '127.0.0.1',
  port: 11434,
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKey: 'custom-local',
  qvacCommand: 'qvac',
  serviceRuntime: process.execPath,
  serviceEntrypoint: join(dirname(fileURLToPath(import.meta.url)), 'local-service.js'),
  cwd: undefined,
  ctxSize: 32768,
  reasoningBudget: -1,
  tools: true,
  readyTimeoutMs: 180_000,
  idleStopMs: 0,
  timeoutSeconds: 300
}

const ZERO_COST: OpenClawCost = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export function createOpenClawModels (options: ResolvedOptions): OpenClawModel[] {
  return qvacCatalog.map((entry) => ({
    id: entry.id,
    name: entry.name,
    reasoning: true,
    input: ['text', 'image'],
    cost: ZERO_COST,
    contextWindow: options.ctxSize,
    maxTokens: 8192,
    compat: { requiresStringContent: true }
  }))
}

export const openClawModels: OpenClawModel[] = createOpenClawModels(DEFAULT_OPTIONS)

export const openClawCatalogRows: readonly OpenClawCatalogRow[] = qvacCatalog.map((entry) => ({
  kind: 'text',
  provider: 'qvac',
  model: entry.id,
  label: entry.name,
  source: 'static'
}))

function resolveOpenClawModelsMode (mode: string | undefined): OpenClawModelsMode {
  return mode === 'replace' ? 'replace' : 'merge'
}

function coerceString (option: string, value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`${option} must be a string`)
  return value
}

function coerceNumber (option: string, value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new TypeError(`${option} must be a finite number`)
  return n
}

function coerceBoolean (option: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new TypeError(`${option} must be a boolean`)
}

export function resolveOptions (raw: RawOptions = {}): ResolvedOptions {
  const host = raw.host === undefined ? DEFAULT_OPTIONS.host : coerceString('host', raw.host)
  const port = raw.port === undefined ? DEFAULT_OPTIONS.port : coerceNumber('port', raw.port)
  const baseUrl = raw.baseUrl === undefined ? `http://${host}:${port}/v1` : coerceString('baseUrl', raw.baseUrl)
  return {
    model: raw.model === undefined ? DEFAULT_OPTIONS.model : coerceString('model', raw.model),
    host,
    port,
    baseUrl,
    apiKey: raw.apiKey === undefined ? DEFAULT_OPTIONS.apiKey : coerceString('apiKey', raw.apiKey),
    qvacCommand: raw.qvacCommand === undefined ? DEFAULT_OPTIONS.qvacCommand : coerceString('qvacCommand', raw.qvacCommand),
    serviceRuntime:
      raw.serviceRuntime === undefined
        ? DEFAULT_OPTIONS.serviceRuntime
        : coerceString('serviceRuntime', raw.serviceRuntime),
    serviceEntrypoint:
      raw.serviceEntrypoint === undefined
        ? DEFAULT_OPTIONS.serviceEntrypoint
        : coerceString('serviceEntrypoint', raw.serviceEntrypoint),
    cwd: raw.cwd === undefined ? DEFAULT_OPTIONS.cwd : coerceString('cwd', raw.cwd),
    ctxSize: raw.ctxSize === undefined ? DEFAULT_OPTIONS.ctxSize : coerceNumber('ctxSize', raw.ctxSize),
    reasoningBudget:
      raw.reasoningBudget === undefined
        ? DEFAULT_OPTIONS.reasoningBudget
        : coerceNumber('reasoningBudget', raw.reasoningBudget),
    tools: raw.tools === undefined ? DEFAULT_OPTIONS.tools : coerceBoolean('tools', raw.tools),
    readyTimeoutMs:
      raw.readyTimeoutMs === undefined
        ? DEFAULT_OPTIONS.readyTimeoutMs
        : coerceNumber('readyTimeoutMs', raw.readyTimeoutMs),
    idleStopMs: raw.idleStopMs === undefined ? DEFAULT_OPTIONS.idleStopMs : coerceNumber('idleStopMs', raw.idleStopMs),
    timeoutSeconds:
      raw.timeoutSeconds === undefined
        ? DEFAULT_OPTIONS.timeoutSeconds
        : coerceNumber('timeoutSeconds', raw.timeoutSeconds)
  }
}

export function createQvacServeModels (options: ResolvedOptions): Record<string, QvacServeModel> {
  const models: Record<string, QvacServeModel> = {}
  for (const entry of qvacCatalog) {
    models[entry.id] = {
      model: resolveModelConstant(entry.id),
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

export function createOpenClawProvider (options: ResolvedOptions): OpenClawProvider {
  return {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    api: 'openai-completions',
    timeoutSeconds: options.timeoutSeconds,
    localService: {
      command: options.serviceRuntime,
      args: [
        options.serviceEntrypoint,
        '--qvac-command',
        options.qvacCommand,
        '--model',
        options.model,
        '--host',
        options.host,
        '--port',
        String(options.port),
        '--ctx-size',
        String(options.ctxSize),
        '--reasoning-budget',
        String(options.reasoningBudget),
        '--tools',
        String(options.tools)
      ],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      healthUrl: `${options.baseUrl}/models`,
      readyTimeoutMs: options.readyTimeoutMs,
      idleStopMs: options.idleStopMs
    },
    models: createOpenClawModels(options)
  }
}

export function createQvacSetupResult (
  config: OpenClawConfigLike,
  rawOptions: RawOptions = {}
): QvacProviderAuthResult {
  const options = resolveOptions(rawOptions)
  const defaultModel = `qvac/${options.model}`
  return {
    profiles: [],
    configPatch: {
      agents: {
        defaults: {
          experimental: {
            ...config.agents?.defaults?.experimental,
            localModelLean: true
          },
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
      }
    },
    defaultModel,
    notes: ['Configured QVAC as a local OpenAI-compatible provider.']
  }
}

export function applyQvacSetupConfig (config: OpenClawConfigLike, rawOptions: RawOptions = {}): OpenClawConfigLike {
  const setup = createQvacSetupResult(config, rawOptions).configPatch
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        experimental: setup.agents.defaults.experimental,
        models: setup.agents.defaults.models
      }
    },
    models: {
      ...config.models,
      mode: setup.models.mode,
      providers: setup.models.providers
    }
  }
}

export function registerQvacProvider (api: QvacProviderRegistration, rawOptions: RawOptions = {}): void {
  const pluginConfig = api.pluginConfig ?? {}
  const mergedOptions = () => ({ ...pluginConfig, ...rawOptions })
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
    auth: [{
      id: 'local',
      label: 'Local QVAC',
      hint: 'Start qvac serve through OpenClaw localService',
      kind: 'custom',
      run: async ({ config }) => createQvacSetupResult(config, mergedOptions()),
      runNonInteractive: async ({ config }) => applyQvacSetupConfig(config, mergedOptions())
    }],
    resolveSyntheticAuth: () => ({
      apiKey: 'custom-local',
      source: 'qvac plugin (synthetic local key)',
      mode: 'api-key'
    }),
    shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) => resolvedApiKey === 'custom-local' || resolvedApiKey === 'qvac-local',
    catalog: {
      order: 'simple',
      run: async () => ({ provider: providerConfig() })
    },
    staticCatalog: {
      order: 'simple',
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
