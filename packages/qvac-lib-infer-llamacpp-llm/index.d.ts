import BaseInference, {
  ReportProgressCallback
} from '@qvac/infer-base/WeightsProvider/BaseInference'
import type { QvacResponse } from '@qvac/infer-base'
import type QvacLogger from '@qvac/logging'

export type NumericLike = number | `${number}`

export interface Loader {
  ready(): Promise<void>
  close(): Promise<void>
  getStream(path: string): Promise<AsyncIterable<Uint8Array>>
  download(
    path: string,
    opts: { diskPath: string; progressReporter?: unknown }
  ): Promise<{ await(): Promise<void> }>
  getFileSize?(path: string): Promise<number>
}

export interface Addon {
  loadWeights(data: { filename: string; chunk: Uint8Array | null; completed: boolean }, logger?: QvacLogger): Promise<void>
  activate(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  status(): Promise<string>
  append(input: { type: 'text' | 'media' | 'end of job'; input?: string | Uint8Array }): Promise<number>
  cancel(jobId?: number): Promise<void>
  destroyInstance(): Promise<void>
  unload(): Promise<void>
}

export interface LlamaConfig {
  device?: string
  gpu_layers?: NumericLike
  ctx_size?: NumericLike
  system_prompt?: string
  lora?: string
  temp?: NumericLike
  top_p?: NumericLike
  top_k?: NumericLike
  predict?: NumericLike
  seed?: NumericLike
  no_mmap?: boolean | ''
  reverse_prompt?: string
  repeat_penalty?: NumericLike
  presence_penalty?: NumericLike
  frequency_penalty?: NumericLike
  tools?: boolean | string
  verbosity?: NumericLike
  n_discarded?: NumericLike
  'main-gpu'?: NumericLike | string
  [key: string]: string | number | boolean | string[] | undefined
}

export interface LlmLlamacppArgs {
  loader: Loader
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
  diskPath?: string
  modelName: string
  projectionModel?: string
  modelPath?: string
  modelConfig?: Record<string, string>
}

export interface UserTextMessage {
  role: 'system' | 'assistant' | 'user' | 'tool' | 'session' | string
  content: string
  type?: undefined
  [key: string]: any
}

export interface UserMediaMessage {
  role: 'user'
  type: 'media'
  content: Uint8Array
}

export interface ChatFunctionDefinition {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, any>
}

export type Message =
  | UserTextMessage
  | UserMediaMessage
  | ChatFunctionDefinition

export interface DownloadWeightsOptions {
  closeLoader?: boolean
}

export interface DownloadResult {
  filePath: string | null
  error: boolean
  completed: boolean
}

export default class LlmLlamacpp extends BaseInference {
  protected addon: Addon

  constructor(args: LlmLlamacppArgs, config: LlamaConfig)

  _load(
    closeLoader?: boolean,
    onDownloadProgress?: ReportProgressCallback | ((bytes: number) => void)
  ): Promise<void>

  load(
    closeLoader?: boolean,
    onDownloadProgress?: ReportProgressCallback | ((bytes: number) => void)
  ): Promise<void>

  downloadWeights(
    onDownloadProgress?: (progress: Record<string, any>, opts: DownloadWeightsOptions) => any,
    opts?: DownloadWeightsOptions
  ): Promise<Record<string, DownloadResult>>

  _downloadWeights(
    onDownloadProgress?: (progress: Record<string, any>, opts: DownloadWeightsOptions) => any,
    opts?: DownloadWeightsOptions
  ): Promise<Record<string, DownloadResult>>

  _runInternal(prompt: Message[]): Promise<QvacResponse>

  run(prompt: Message[]): Promise<QvacResponse>

  unload(): Promise<void>

  pause(): Promise<void>

  unpause(): Promise<void>

  stop(): Promise<void>

  cancel(jobId?: string): Promise<void>

  status(): Promise<any>

  destroy(): Promise<void>

  getState(): { configLoaded: boolean; weightsLoaded: boolean; destroyed: boolean }

  getApiDefinition(): string
}

export { ReportProgressCallback, QvacResponse }
