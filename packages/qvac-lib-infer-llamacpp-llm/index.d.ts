import type { QvacResponse } from '@qvac/infer-base'
import type QvacLogger from '@qvac/logging'

export type NumericLike = number | `${number}`

export interface AddonMessage {
  type: 'text'
  input: string
  prefill?: boolean
  /**
   * Per-call sampling overrides forwarded by `LlmLlamacpp.run()` from
   * `RunOptions.generationParams`. Carried on the `text` message and consumed
   * by the native binding so each `runJob` can use a different temp / top_p /
   * seed / etc. without re-loading the model.
   */
  generationParams?: GenerationParams
  cacheKey?: string
  saveCacheToDisk?: boolean
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
  /** How to split the model across GPUs: 'none' (default, single GPU), 'layer' (pipeline parallelism), 'row' (tensor parallelism). */
  'split-mode'?: 'none' | 'layer' | 'row'
  /** Proportions for distributing layers/rows across GPUs (e.g. '1,1' for equal split, '3,1' for 75/25). */
  'tensor-split'?: string
  'cache-type-k'?: string
  'cache-type-v'?: string
  /** Writable directory for OpenCL kernel binary cache. Required on Android for fast GPU startup. */
  openclCacheDir?: string
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
  /**
   * Either the raw bytes of an image/audio/video file (`Uint8Array`) or an
   * absolute path to a file on disk (`string`). Path-mode is handled by the
   * C++ layer via `loadMedia()`; byte-mode takes the `parseMedia` path.
   */
  content: Uint8Array | string
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
  /**
   * GBNF grammar applied per request to constrain sampling. Equivalent to
   * the load-time `--grammar` config but scoped to a single `run()` call;
   * the sampler is re-initialized with this grammar for the request and
   * the prior grammar is restored afterwards.
   *
   * `undefined` or an empty string is treated as "no override" and falls
   * through to whatever grammar was set at load time (typically none).
   *
   * Mutually exclusive with `json_schema` — passing both throws.
   */
  grammar?: string
  /**
   * JSON Schema applied per request to constrain sampling to valid JSON
   * matching the schema. Equivalent to the load-time `--json-schema`
   * config but scoped to a single `run()` call; the schema is converted
   * to GBNF natively (via llama.cpp's `json_schema_to_grammar()`) and
   * applied identically to `grammar`.
   *
   * Accepts either a JSON Schema object literal or a pre-stringified
   * JSON Schema. Mutually exclusive with `grammar` — passing both throws.
   */
  json_schema?: string | Record<string, unknown>
}

export interface RunOptions {
  prefill?: boolean
  generationParams?: GenerationParams
  cacheKey?: string
  saveCacheToDisk?: boolean
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
  /** Fraction of training data to hold out for validation (0–1). Default 0.05. */
  fraction?: number
}

export interface FinetuneValidationDataset {
  type: 'dataset'
  /** Path to a separate eval dataset file. Must differ from trainDatasetDir. */
  path: string
}

export type FinetuneValidation =
  | FinetuneValidationNone
  | FinetuneValidationSplit
  | FinetuneValidationDataset

export interface FinetuneOptions {
  /** Path to training dataset file (.jsonl for SFT, .txt for causal). */
  trainDatasetDir: string
  /** How to run validation. */
  validation: FinetuneValidation
  /** Directory (or file path ending in .gguf) for the final LoRA adapter. */
  outputParametersDir: string
  /** Number of training epochs. Default 1. */
  numberOfEpochs?: number
  /** Initial learning rate. Default 1e-4. */
  learningRate?: number
  /** Training sequence length. Default 128. */
  contextLength?: number
  /** Backend n_batch (tokens per batch). Must be >= microBatchSize and divisible by it. Default 128. */
  batchSize?: number
  /** Backend n_ubatch (micro-batch size). Must be <= batchSize. Default 128. */
  microBatchSize?: number
  /** Use SFT (chat) mode when true; causal (next-token) when false. Default false. */
  assistantLossOnly?: boolean
  /** Comma-separated LoRA target modules (e.g. 'attn_q,attn_k,attn_v,attn_o'). Default: attention Q/K/V/O. */
  loraModules?: string
  /** LoRA rank. Default 8. */
  loraRank?: number
  /** LoRA alpha (scaling factor). Default 16.0. */
  loraAlpha?: number
  /** LoRA init standard deviation. Default 0.02. */
  loraInitStd?: number
  /** Seed for LoRA weight initialization (0 = non-deterministic). Default 42. */
  loraSeed?: number
  /** Directory for checkpoints. Default './checkpoints'. */
  checkpointSaveDir?: string
  /** Save a checkpoint every N optimizer steps (0 = only on pause). Default 0. */
  checkpointSaveSteps?: number
  /** Path to a custom chat template file (for SFT). */
  chatTemplatePath?: string
  /** Learning rate scheduler: 'constant', 'cosine', or 'linear'. Default 'cosine'. */
  lrScheduler?: 'constant' | 'cosine' | 'linear'
  /** Minimum learning rate (for cosine/linear schedulers). Default 0. */
  lrMin?: number
  /** Warmup ratio (0–1). Requires warmupRatioSet: true. Default 0.1. */
  warmupRatio?: number
  /** When true, compute warmup steps from warmupRatio. */
  warmupRatioSet?: boolean
  /** Explicit warmup steps (used when warmupStepsSet is true). Default 0. */
  warmupSteps?: number
  /** When true, use warmupSteps directly instead of ratio. */
  warmupStepsSet?: boolean
  /** Weight decay. Default 0.01. */
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

/** Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole entry for single-file models. */
export function pickPrimaryGgufPath(files: string[]): string
