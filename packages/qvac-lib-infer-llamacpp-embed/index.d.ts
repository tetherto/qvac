import BaseInference from '@qvac/infer-base/WeightsProvider/BaseInference'
import type { QvacResponse } from '@qvac/infer-base'

export { QvacResponse }
import type QvacLogger from '@qvac/logging'

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
  embed_normalize?: NumericLike
  flash_attn?: 'on' | 'off' | 'auto'
  'main-gpu'?: NumericLike | 'integrated' | 'dedicated'
  verbosity?: NumericLike
  [key: string]: string | number | boolean | string[] | undefined
}

export interface GGMLArgs {
  files: { model: string[] }
  config?: string | GGMLConfig
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
}

export interface AddonConfigurationParams {
  path: string
  config: string | GGMLConfig
  backendsDir?: string
}

export default class GGMLBert extends BaseInference {
  protected addon: Addon

  constructor(args: GGMLArgs)

  _load(): Promise<void>

  load(): Promise<void>

  protected _createAddon(configurationParams: AddonConfigurationParams): Addon

  _runInternal(text: string | string[]): Promise<QvacResponse>

  run(text: string | string[]): Promise<QvacResponse>

  cancel(): Promise<void>
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
