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

export interface FinetuningParams {
  trainDatasetDir: string
  evalDatasetDir: string
  outputParametersDir: string
  numberOfEpochs?: number
  learningRate?: number
  lrMin?: number
  lrScheduler?: string
  warmupRatio?: number
  warmupSteps?: number
  loraRank?: number
  loraAlpha?: number
  loraModules?: string
  loraDropout?: number
  loraInitStd?: number
  outputAdapterPath?: string
  weightDecay?: number
  checkpointSaveSteps?: number
  checkpointSaveDir?: string
  resumeFromCheckpoint?: string
  autoResume?: boolean
  assistantLossOnly?: boolean
  chatTemplatePath?: string
  contextLength?: number
  batchSize?: number
  microBatchSize?: number
}

export interface Addon {
  loadWeights(data: { filename: string; chunk: Uint8Array | null; completed: boolean }, logger?: QvacLogger): Promise<void>
  activate(): Promise<void>
  runJob(data: { type: 'text' | 'media'; input?: string; content?: Uint8Array }): Promise<unknown>
  cancel(jobId?: number): Promise<void>
  status?(): Promise<string>
  pause?(): Promise<void>
  finetune?(params?: FinetuningParams): Promise<void>
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
  opts?: Record<string, unknown>
  diskPath?: string
  modelName: string
  projectionModel?: string
}

export interface Message {
  role: 'system' | 'assistant' | 'user' | 'tool' | 'session' | string
  content: string
  type?: 'media'
  [key: string]: unknown
}

declare class LlmLlamacpp extends BaseInference {
  constructor(
    args: LlmLlamacppArgs,
    config: LlamaConfig,
    finetuningParams?: FinetuningParams | null
  )

  _load(
    closeLoader?: boolean,
    onDownloadProgress?: ReportProgressCallback | ((bytes: number) => void)
  ): Promise<void>

  _runInternal(prompt: Message[]): Promise<QvacResponse>
  run(prompt: Message[]): Promise<QvacResponse>
  cancel(jobId?: number): Promise<void>
  unload(): Promise<void>
  finetune(options?: FinetuningParams): Promise<{ status: string }>
  pauseFinetune(): Promise<void>
  resumeFinetune(): Promise<void>
  status(): Promise<string>
}

export = LlmLlamacpp
