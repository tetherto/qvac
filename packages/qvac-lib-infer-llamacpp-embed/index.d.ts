import type { QvacResponse } from '@qvac/infer-base'
import type QvacLogger from '@qvac/logging'

export { QvacResponse }

export interface Addon {
  loadWeights(data: { filename: string; chunk: Uint8Array | null; completed: boolean }): Promise<void>
  activate(): Promise<void>
  runJob(input: { type: 'text' | 'sequences'; input?: string | string[] }): Promise<boolean>
  cancel(): Promise<void>
  unload(): Promise<void>
}

export type NumericLike = `${number}`

export interface GGMLConfig {
  device: 'gpu' | 'cpu'
  gpu_layers?: NumericLike
  batch_size?: NumericLike
  pooling?: 'none' | 'mean' | 'cls' | 'last' | 'rank'
  attention?: 'causal' | 'non-causal'
  embd_normalize?: NumericLike
  flash_attn?: 'on' | 'off' | 'auto'
  'main-gpu'?: NumericLike | 'integrated' | 'dedicated'
  verbosity?: NumericLike
  /** Writable directory for OpenCL kernel binary cache. Required on Android for fast GPU startup. */
  openclCacheDir?: string
  [key: string]: string | number | boolean | string[] | undefined
}

export interface GGMLBertArgs {
  files: { model: string[] }
  config?: GGMLConfig
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
}

export interface AddonConfigurationParams {
  path: string
  config: GGMLConfig
  backendsDir?: string
}

export interface RuntimeStats {
  total_tokens: number
  total_time_ms: number
  tokens_per_second?: number
  batch_size: number
  context_size: number
  backendDevice: 'cpu' | 'gpu'
}

export default class GGMLBert {
  protected addon: Addon | null
  opts: { stats?: boolean }
  logger: QvacLogger
  state: { configLoaded: boolean }

  constructor(args: GGMLBertArgs)

  load(): Promise<void>
  run(text: string | string[]): Promise<QvacResponse>
  unload(): Promise<void>
  cancel(): Promise<void>
  getState(): { configLoaded: boolean }
}

export { GGMLBert }

export interface AddonLogging {
  setLogger(callback: (priority: number, message: string) => void): void
  releaseLogger(): void
}
export const addonLogging: AddonLogging

export class BertInterface implements Addon {
  constructor(
    binding: unknown,
    configurationParams: AddonConfigurationParams,
    outputCb: (addon: unknown, event: string, data: unknown, error?: Error) => void
  )

  loadWeights(data: { filename: string; chunk: Uint8Array | null; completed: boolean }): Promise<void>
  activate(): Promise<void>
  runJob(input: { type: 'text' | 'sequences'; input?: string | string[] }): Promise<boolean>
  cancel(): Promise<void>
  unload(): Promise<void>
}

/** Returns the first shard (matching `-NNNNN-of-MMMMM.gguf`) or the sole entry for single-file models. */
export function pickPrimaryGgufPath(files: string[]): string
