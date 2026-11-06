import {
  createJobHandler,
  exclusiveRunQueue,
  type JobHandler,
  type QvacResponse
} from '@qvac/infer-base'
import type { ServerProcess } from '@qvac/sglang'
import { LlmSglangInterface, mapAddonEvent, type AddonLogger, type LlmSglangBinding } from './addon'

const SERVER_NOT_STARTED = 'SGLang server is not started. Call load() first.'

// @qvac/sglang is ESM. A static import() is rewritten to require() under
// CommonJS, which throws ERR_REQUIRE_ESM, so keep the import unevaluated.
function importSglang(): Promise<typeof import('@qvac/sglang')> {
  return new Function('return import("@qvac/sglang")')() as Promise<typeof import('@qvac/sglang')>
}

const serverOptionKeys = [
  'maxConnections',
  'tpSize',
  'epSize',
  'dpSize',
  'ppSize',
  'cpSize',
  'contextLength',
  'maxTotalTokens',
  'maxRunningRequests',
  'maxPrefillTokens',
  'memFractionStatic',
  'cudaGraphBatchSizes',
  'cachePolicy',
  'maxHttpRequests',
  'maxRequestBytes',
  'apiKey',
  'corsAllowOrigin',
  'queueTimeout',
  'requestTimeout',
  'streamIdleTimeout',
  'cudaGraph',
  'extraArgs',
  'artifacts'
] as const

export interface TextMessage {
  role: string
  content: string
  type?: undefined
}

export interface MediaMessage {
  role: 'user'
  type: 'media' | 'image' | 'audio' | 'video'
  content: Uint8Array | string
  mediaType?: string
  mime?: string
}

export type Message = TextMessage | MediaMessage

export interface GenerationParams {
  temp?: number
  temperature?: number
  top_p?: number
  top_k?: number
  predict?: number
  max_tokens?: number
  seed?: number
  frequency_penalty?: number
  presence_penalty?: number
  repeat_penalty?: number
  repetition_penalty?: number
  grammar?: string
  json_schema?: string | Record<string, unknown>
}

export interface RunOptions {
  generationParams?: GenerationParams
}

export interface LlmSglangConfig {
  baseUrl?: string
  host?: string
  port?: number
  readyTimeoutMs?: number
  maxConnections?: number
  tpSize?: number
  epSize?: number
  dpSize?: number
  ppSize?: number
  cpSize?: number
  contextLength?: number
  maxTotalTokens?: number
  maxRunningRequests?: number
  maxPrefillTokens?: number
  memFractionStatic?: number
  cudaGraphBatchSizes?: string
  cachePolicy?: string
  maxHttpRequests?: number
  maxRequestBytes?: number
  apiKey?: string
  corsAllowOrigin?: string
  queueTimeout?: number
  requestTimeout?: number
  streamIdleTimeout?: number
  cudaGraph?: boolean
  extraArgs?: string[]
  artifacts?: string
}

export interface LlmSglangArgs {
  files?: { model?: string[] }
  config?: LlmSglangConfig
  logger?: AddonLogger | null
}

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>

function lower(value: string): string {
  return value.toLowerCase()
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : lower(path.slice(dot + 1))
}

function mediaKind(message: MediaMessage): 'image' | 'audio' | 'video' {
  const hint = lower(`${message.type} ${message.mediaType ?? ''} ${message.mime ?? ''}`)
  if (hint.includes('audio')) return 'audio'
  if (hint.includes('video')) return 'video'
  const path = typeof message.content === 'string' ? message.content : ''
  const ext = extensionOf(path)
  if (ext === 'wav' || ext === 'mp3' || ext === 'flac' || ext === 'ogg' || ext === 'm4a') {
    return 'audio'
  }
  if (ext === 'mp4' || ext === 'webm' || ext === 'mov' || ext === 'mkv') {
    return 'video'
  }
  return 'image'
}

function isMediaMessage(message: Message): message is MediaMessage {
  return (
    message.type === 'media' ||
    message.type === 'image' ||
    message.type === 'audio' ||
    message.type === 'video'
  )
}

export function validateMessages(messages: unknown): asserts messages is Message[] {
  if (!Array.isArray(messages)) {
    throw new TypeError('Prompt input must be Message[]')
  }
  if (messages.length === 0) {
    throw new TypeError('messages must not be empty')
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      throw new TypeError('each message must be an object')
    }
    const candidate = message as Partial<Message>
    if (typeof candidate.role !== 'string' || candidate.role.length === 0) {
      throw new TypeError('each message requires a role')
    }
    if (typeof candidate.content !== 'string' && !(candidate.content instanceof Uint8Array)) {
      throw new TypeError('message content must be a string or Uint8Array')
    }
    if (isMediaMessage(candidate as Message)) {
      const kind = mediaKind(candidate as MediaMessage)
      if (kind === 'audio') {
        throw new TypeError('audio inputs are not supported')
      }
      if (kind === 'video') {
        throw new TypeError('video inputs are not supported')
      }
    }
  }
}

function normalizeGenerationParams(
  params: GenerationParams | undefined
): Record<string, unknown> | undefined {
  if (params === undefined) return undefined
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('generationParams must be an object when provided')
  }
  const normalized: Record<string, unknown> = { ...params }
  if (normalized.temp !== undefined && normalized.temperature === undefined) {
    normalized.temperature = normalized.temp
  }
  delete normalized.temp
  if (normalized.predict !== undefined && normalized.max_tokens === undefined) {
    normalized.max_tokens = normalized.predict
  }
  delete normalized.predict
  if (normalized.repeat_penalty !== undefined && normalized.repetition_penalty === undefined) {
    normalized.repetition_penalty = normalized.repeat_penalty
  }
  delete normalized.repeat_penalty
  if (normalized.json_schema && typeof normalized.json_schema === 'object') {
    normalized.json_schema = JSON.stringify(normalized.json_schema)
  }
  return normalized
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitUntilReady(
  baseUrl: string,
  server: ServerProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let exited: number | null | undefined
  server.on('exit', (code) => {
    exited = code
  })
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      throw new Error(`SGLang server exited before it was ready (code ${exited ?? 'null'})`)
    }
    try {
      const response = await fetch(`${baseUrl}/ready`)
      if (response.ok) return
    } catch {
      // The process is still binding its port.
    }
    await sleep(500)
  }
  throw new Error(`SGLang server was not ready within ${timeoutMs}ms`)
}

export class LlmSglang {
  readonly logger: AddonLogger | null
  private readonly files: { model?: string[] }
  private readonly config: LlmSglangConfig
  private addon: LlmSglangInterface | null
  private server: ServerProcess | null
  private readonly job: JobHandler
  private readonly runExclusive: RunExclusive
  private loaded: boolean

  constructor({ files = {}, config = {}, logger = null }: LlmSglangArgs = {}) {
    this.files = files
    this.config = config
    this.logger = logger
    this.addon = null
    this.server = null
    this.loaded = false
    this.job = createJobHandler({
      cancel: () => this.addon?.cancel()
    })
    this.runExclusive = exclusiveRunQueue() as RunExclusive
  }

  async load(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.loaded) return
      const baseUrl = await this.ensureServer()
      try {
        // The native module is resolved only after the server URL is known.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const binding = require('./binding') as LlmSglangBinding
        this.addon = new LlmSglangInterface(
          binding,
          { baseUrl, apiKey: this.config.apiKey },
          this.onOutput.bind(this)
        )
        await this.addon.activate()
        this.loaded = true
        this.logger?.info?.('SGLang addon loaded')
      } catch (error) {
        await this.addon?.unload()
        this.addon = null
        this.stopServer()
        throw error
      }
    })
  }

  run(messages: Message[], runOptions?: RunOptions): QvacResponse<string> {
    validateMessages(messages)
    if (
      runOptions !== undefined &&
      (typeof runOptions !== 'object' || runOptions === null || Array.isArray(runOptions))
    ) {
      throw new TypeError('Run options must be an object when provided')
    }
    const generationParams = normalizeGenerationParams(runOptions?.generationParams)
    if (!this.loaded || !this.addon) {
      throw new Error(SERVER_NOT_STARTED)
    }
    const response = this.job.start()
    const addon = this.addon
    void Promise.resolve(addon.runJob({ messages, generationParams })).then(
      (accepted) => {
        if (!accepted) {
          this.job.fail(new Error('SGLang job was rejected'))
        }
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.job.fail(failure)
      }
    )
    return response
  }

  async cancel(): Promise<void> {
    await this.addon?.cancel()
  }

  async unload(): Promise<void> {
    return this.runExclusive(async () => {
      try {
        await this.addon?.cancel()
      } catch {
        // Unload still destroys the instance.
      }
      if (this.job.active) {
        this.job.fail(new Error('Model was unloaded'))
      }
      if (this.addon) {
        await this.addon.unload()
        this.addon = null
      }
      this.stopServer()
      this.loaded = false
    })
  }

  private async ensureServer(): Promise<string> {
    if (this.config.baseUrl) {
      return trimSlash(this.config.baseUrl)
    }
    const model = this.files.model?.[0]
    if (!model) {
      throw new Error('load() requires files.model or config.baseUrl')
    }
    const host = this.config.host ?? '127.0.0.1'
    const port = this.config.port ?? 30000
    const options: Record<string, unknown> = { model, host, port, stdio: 'inherit' }
    for (const key of serverOptionKeys) {
      const value = this.config[key]
      if (value !== undefined) options[key] = value
    }
    const sglang = await importSglang()
    this.server = sglang.startServer(options)
    const baseUrl = `http://${host}:${port}`
    try {
      await waitUntilReady(baseUrl, this.server, this.config.readyTimeoutMs ?? 600_000)
    } catch (error) {
      this.stopServer()
      throw error
    }
    return baseUrl
  }

  private stopServer(): void {
    const server = this.server
    this.server = null
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
    }
  }

  private onOutput(
    _addon: LlmSglangInterface,
    event: unknown,
    data: unknown,
    error: unknown
  ): void {
    const mapped = mapAddonEvent(event, data, error)
    if (mapped === null) return
    if (mapped.type === 'Output') {
      if (typeof mapped.data === 'string' && mapped.data.length > 0) {
        this.job.output(mapped.data)
      }
      return
    }
    if (mapped.type === 'Error') {
      const failure =
        mapped.error instanceof Error
          ? mapped.error
          : new Error(typeof mapped.error === 'string' ? mapped.error : 'SGLang request failed')
      this.job.fail(failure)
      return
    }
    this.job.end()
  }
}

export default LlmSglang

const cjsExports = LlmSglang as typeof LlmSglang & {
  LlmSglang?: typeof LlmSglang
  validateMessages?: typeof validateMessages
}
cjsExports.LlmSglang = LlmSglang
cjsExports.validateMessages = validateMessages
module.exports = cjsExports
