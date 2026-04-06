import BaseInference, {
  ReportProgressCallback
} from '@qvac/infer-base/WeightsProvider/BaseInference'
import type { QvacResponse } from '@qvac/infer-base'
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

export interface TranslationNmtcppParams {
  dstLang: string
  srcLang: string
  [key: string]: unknown
}

export interface TranslationNmtcppArgs {
  loader: Loader
  params: TranslationNmtcppParams
  diskPath: string
  modelName: string
  logger?: QvacLogger
  [key: string]: unknown
}

export interface TranslationNmtcppModelTypes {
  readonly IndicTrans: "IndicTrans"
  readonly Bergamot: "Bergamot"
}

export type BergamotPivotModel = Omit<TranslationNmtcppConfig, 'modelType' | 'bergamotPivotModel'> & { loader: Loader,  modelName: string, diskPath: string }

export interface TranslationNmtcppConfig {
  modelType: TranslationNmtcppModelTypes[keyof TranslationNmtcppModelTypes]
  srcVocabPath?: string
  dstVocabPath?: string
  bergamotPivotModel?: BergamotPivotModel
  [key: string]: unknown
}

export default class TranslationNmtcpp extends BaseInference {
  static readonly ModelTypes: TranslationNmtcppModelTypes
  constructor(args: TranslationNmtcppArgs, config: TranslationNmtcppConfig)
  load(
      close?: boolean,
      reportProgressCallback?: ReportProgressCallback
  ): Promise<void>
  run(input: string): Promise<QvacResponse<string>>
  runBatch(texts: string[]): Promise<string[]>
  unload(): Promise<void>;
}
