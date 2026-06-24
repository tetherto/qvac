import { qvacCatalog, resolveModelConstant } from '@qvac/ai-sdk-provider/models'

export interface ResolvedOptions {
  readonly model: string
  readonly host: string
  readonly port: number
  readonly baseUrl: string
  readonly apiKey: string
  readonly qvacCommand: string
  readonly configPath: string
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
    readonly auth: never[]
    readonly catalog: {
      readonly order: 'simple'
      run(): Promise<{ provider: OpenClawProvider }>
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
  apiKey: 'qvac-local',
  qvacCommand: 'qvac',
  configPath: 'qvac.config.json',
  cwd: undefined,
  ctxSize: 32768,
  reasoningBudget: -1,
  tools: true,
  readyTimeoutMs: 180_000,
  idleStopMs: 0,
  timeoutSeconds: 300
}

const ZERO_COST: OpenClawCost = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export const openClawModels: OpenClawModel[] = qvacCatalog.map((entry) => ({
  id: entry.id,
  name: entry.name,
  reasoning: true,
  input: ['text', 'image'],
  cost: ZERO_COST,
  contextWindow: DEFAULT_OPTIONS.ctxSize,
  maxTokens: 8192,
  compat: { requiresStringContent: true }
}))

export const openClawCatalogRows: readonly OpenClawCatalogRow[] = qvacCatalog.map((entry) => ({
  kind: 'text',
  provider: 'qvac',
  model: entry.id,
  label: entry.name,
  source: 'static'
}))

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
    configPath: raw.configPath === undefined ? DEFAULT_OPTIONS.configPath : coerceString('configPath', raw.configPath),
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
      command: options.qvacCommand,
      args: [
        'serve',
        'openai',
        '--config',
        options.configPath,
        '--host',
        options.host,
        '--port',
        String(options.port),
        '--model',
        options.model
      ],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      healthUrl: `${options.baseUrl}/models`,
      readyTimeoutMs: options.readyTimeoutMs,
      idleStopMs: options.idleStopMs
    },
    models: openClawModels
  }
}

export function registerQvacProvider (api: QvacProviderRegistration, rawOptions: RawOptions = {}): void {
  const pluginConfig = api.pluginConfig ?? {}
  api.registerModelCatalogProvider?.({
    provider: 'qvac',
    kinds: ['text'],
    staticCatalog: () => openClawCatalogRows
  })

  api.registerProvider({
    id: 'qvac',
    label: 'QVAC',
    docsPath: '/providers/qvac',
    auth: [],
    catalog: {
      order: 'simple',
      run: async () => ({ provider: createOpenClawProvider(resolveOptions({ ...pluginConfig, ...rawOptions })) })
    }
  })
}
