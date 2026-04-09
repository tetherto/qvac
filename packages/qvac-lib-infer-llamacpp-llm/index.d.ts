import type { QvacResponse } from '@qvac/infer-base'
import type QvacLogger from '@qvac/logging'

export type NumericLike = number | `${number}`

export interface AddonMessage {
  type: 'text'
  input: string
  prefill?: boolean
}
export interface AddonMediaMessage {
  type: 'media'
  content: Uint8Array
}
export type AddonRunJobMessage = AddonMessage | AddonMediaMessage

export interface Addon {
  loadWeights(data: { filename: string; chunk: Uint8Array | null; completed: boolean }, logger?: QvacLogger): Promise<void>
  activate(): Promise<void>
  runJob(data: AddonRunJobMessage[]): Promise<boolean>
  cancel(): Promise<void>
  finetune?(params: FinetuneOptions): Promise<boolean>
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
  files: { model: string[]; projectionModel?: string }
  config: LlamaConfig
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
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

export interface GenerationParams {
  temp?: number
  top_p?: number
  top_k?: number
  predict?: number
  seed?: number
  frequency_penalty?: number
  presence_penalty?: number
  repeat_penalty?: number
}

export interface RunOptions {
  prefill?: boolean
  generationParams?: GenerationParams
}

export interface RuntimeStats {
  TTFT: number
  TPS: number
  CacheTokens: number
  generatedTokens: number
  promptTokens: number
  contextSlides: number
  backendDevice: 'cpu' | 'gpu'
}

export interface FinetuneValidationNone {
  type: 'none'
}

export interface FinetuneValidationSplit {
  type: 'split'
  fraction?: number
}

export interface FinetuneValidationDataset {
  type: 'dataset'
  path: string
}

export type FinetuneValidation =
  | FinetuneValidationNone
  | FinetuneValidationSplit
  | FinetuneValidationDataset

export interface FinetuneOptions {
  trainDatasetDir: string
  validation: FinetuneValidation
  outputParametersDir: string
  numberOfEpochs?: number
  learningRate?: number
  contextLength?: number
  batchSize?: number
  microBatchSize?: number
  assistantLossOnly?: boolean
  loraModules?: string
  loraRank?: number
  loraAlpha?: number
  loraInitStd?: number
  loraSeed?: number
  checkpointSaveDir?: string
  checkpointSaveSteps?: number
  chatTemplatePath?: string
  lrScheduler?: 'constant' | 'cosine' | 'linear'
  lrMin?: number
  warmupRatio?: number
  warmupRatioSet?: boolean
  warmupSteps?: number
  warmupStepsSet?: boolean
  weightDecay?: number
}

export interface FinetuneProgressStats {
  is_train: boolean
  loss: number
  loss_uncertainty: number
  accuracy: number
  accuracy_uncertainty: number
  global_steps: number
  current_epoch: number
  current_batch: number
  total_batches: number
  elapsed_ms: number
  eta_ms: number
}

export interface FinetuneHandle {
  on(event: 'stats', cb: (stats: FinetuneProgressStats) => void): this
  removeListener(event: 'stats', cb: (stats: FinetuneProgressStats) => void): this
  await(): Promise<FinetuneResult>
}

export interface FinetuneStats {
  train_loss?: number
  train_loss_uncertainty?: number
  val_loss?: number
  val_loss_uncertainty?: number
  train_accuracy?: number
  train_accuracy_uncertainty?: number
  val_accuracy?: number
  val_accuracy_uncertainty?: number
  learning_rate?: number
  global_steps: number
  epochs_completed: number
}

export interface FinetuneResult {
  op: 'finetune'
  status: 'COMPLETED' | 'PAUSED'
  stats?: FinetuneStats
}

export default class LlmLlamacpp {
  protected addon: Addon | null
  opts: { stats?: boolean }
  logger: QvacLogger
  state: { configLoaded: boolean }

  constructor(args: LlmLlamacppArgs)

  load(): Promise<void>
  run(prompt: Message[], runOptions?: RunOptions): Promise<QvacResponse>
  finetune(finetuningOptions: FinetuneOptions): Promise<FinetuneHandle>
  cancel(): Promise<void>
  pause(): Promise<void>
  unload(): Promise<void>
  getState(): { configLoaded: boolean }
}

export { QvacResponse, FinetuneHandle, FinetuneProgressStats, FinetuneOptions, FinetuneValidation }
