/// <reference types="node" />

import BaseInference from '@qvac/infer-base/WeightsProvider/BaseInference'
import WeightsProvider from '@qvac/infer-base/WeightsProvider/WeightsProvider'
import type QvacResponse from '@qvac/response'
import type Logger from '@qvac/logging'

type NumericLike = number | string

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
  logger?: Logger
  opts?: Record<string, any>
  diskPath: string
  modelName: string
  projectionModel?: string
}

export interface AddonTextMessage {
  type: 'text'
  input: string
}

export interface AddonMediaMessage {
  type: 'media'
  content: Uint8Array
}

export type AddonRunJobMessage = AddonTextMessage | AddonMediaMessage

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
  loadWeights(data: {
    filename: string
    chunk: Uint8Array | null
    completed: boolean
  }): Promise<void>
  activate(): Promise<void>
  runJob(messages: AddonRunJobMessage[]): Promise<boolean>
  cancel(jobId?: number): Promise<void>
  unload(): Promise<void>
  finetune?(params?: FinetuningParams): Promise<void>
  status?(): Promise<string>
  pause?(): Promise<void>
}

export type ProgressReportCallback = (bytes: number) => void

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool' | string
  content: string
  type?: 'media'
}

declare class LlmLlamacpp extends BaseInference {
  protected readonly _config: Record<string, any>
  protected readonly _diskPath: string
  protected readonly _modelName: string
  protected _defaultFinetuneParams: FinetuningParams | null
  protected addon!: Addon
  protected weightsProvider: WeightsProvider

  constructor(
    args: LlmLlamacppArgs,
    config: LlamaConfig,
    finetuningParams?: FinetuningParams | null
  )

  protected _load(
    closeLoader?: boolean,
    onDownloadProgress?: ProgressReportCallback
  ): Promise<void>

  protected _createAddon(
    configurationParams: {
      path: string
      projectionPath: string
      config: LlamaConfig
    },
    finetuningParams?: FinetuningParams | null
  ): Addon

  protected _runInternal(prompt: Message[]): Promise<QvacResponse>

  run(prompt: Message[]): Promise<QvacResponse>
  cancel(): Promise<void>
  unload(): Promise<void>
  finetune(finetuningOptions?: FinetuningParams): Promise<{ status: string }>
  pauseFinetune(): Promise<void>
  resumeFinetune(): Promise<void>
  protected _waitForFinetuneCompletion(options?: {
    pollIntervalMs?: number
    timeoutMs?: number
  }): Promise<string>
}

export = LlmLlamacpp
