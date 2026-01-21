import BaseInference, {
  ReportProgressCallback
} from '@qvac/infer-base/WeightsProvider/BaseInference'
import type { QvacResponse } from '@qvac/infer-base'

export { ReportProgressCallback, QvacResponse }
import type WeightsProvider from '@qvac/infer-base/WeightsProvider/WeightsProvider'
import type QvacLogger from '@qvac/logging'

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
  loadWeights(data: { filename: string; chunk: Uint8Array | null; completed: boolean }): Promise<void>
  activate(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  reset(): Promise<void>
  status(): Promise<string>
  append(input: { type: 'text' | 'sequences' | 'end of job'; input?: string | string[] }): Promise<number>
  cancel(jobId?: number): Promise<void>
  destroyInstance(): Promise<void>
  unload(): Promise<void>
}

export type GGMLConfig = string

export interface GGMLArgs {
  loader: Loader
  logger?: QvacLogger | Console | null
  opts?: { stats?: boolean }
  diskPath?: string
  modelName: string
  modelPath?: string
  exclusiveRun?: boolean
}

export interface DownloadWeightsOptions {
  closeLoader?: boolean
}

export interface DownloadResult {
  filePath: string | null
  error: boolean
  completed: boolean
}

export interface AddonConfigurationParams {
  path: string
  config: GGMLConfig
  backendsDir?: string
}

export default class GGMLBert extends BaseInference {
  protected addon: Addon
  
  weightsProvider: WeightsProvider

  constructor(args: GGMLArgs, config: GGMLConfig)

  _load(
    closeLoader?: boolean,
    reportProgressCallback?: ReportProgressCallback | ((bytes: number) => void)
  ): Promise<void>

  load(
    closeLoader?: boolean,
    reportProgressCallback?: ReportProgressCallback | ((bytes: number) => void)
  ): Promise<void>

  downloadWeights(
    onDownloadProgress?: (progress: Record<string, any>, opts: DownloadWeightsOptions) => any,
    opts?: DownloadWeightsOptions
  ): Promise<Record<string, DownloadResult>>

  _downloadWeights(
    onDownloadProgress?: (progress: Record<string, any>, opts: DownloadWeightsOptions) => any,
    opts?: DownloadWeightsOptions
  ): Promise<Record<string, DownloadResult>>

  protected _loadWeights(
    reportProgressCallback?: ReportProgressCallback | ((bytes: number) => void)
  ): Promise<void>

  protected _createAddon(configurationParams: AddonConfigurationParams): Addon

  _runInternal(text: string | string[]): Promise<QvacResponse>

  run(text: string | string[]): Promise<QvacResponse>
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
    outputCb: (addon: unknown, event: string, jobId: number, data: unknown, error?: Error) => void,
    transitionCb?: ((message: string) => void) | null
  )
  
  loadWeights(data: { filename: string; chunk: Uint8Array | null; completed: boolean }): Promise<void>
  activate(): Promise<void>
  pause(): Promise<void>
  stop(): Promise<void>
  reset(): Promise<void>
  status(): Promise<string>
  append(input: { type: 'text' | 'sequences' | 'end of job'; input?: string | string[] }): Promise<number>
  cancel(jobId?: number): Promise<void>
  destroyInstance(): Promise<void>
  unload(): Promise<void>
}
