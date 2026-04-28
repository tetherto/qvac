import type { QvacResponse } from '@qvac/infer-base'

export interface TranslationNmtcppFiles {
  model: string
  srcVocab?: string
  dstVocab?: string
  pivotModel?: string
  pivotSrcVocab?: string
  pivotDstVocab?: string
}

export interface TranslationNmtcppParams {
  dstLang: string
  srcLang: string
  [key: string]: unknown
}

export interface TranslationNmtcppArgs {
  files: TranslationNmtcppFiles
  params: TranslationNmtcppParams
  config?: TranslationNmtcppConfig
  logger?: any
  opts?: { stats?: boolean }
  [key: string]: unknown
}

export interface TranslationNmtcppModelTypes {
  readonly IndicTrans: "IndicTrans"
  readonly Bergamot: "Bergamot"
}

export interface TranslationNmtcppConfig {
  modelType: TranslationNmtcppModelTypes[keyof TranslationNmtcppModelTypes]
  pivotConfig?: Record<string, unknown>
  [key: string]: unknown
}

export interface InferenceClientState {
  configLoaded: boolean
  weightsLoaded: boolean
  destroyed: boolean
}

export default class TranslationNmtcpp {
  static readonly ModelTypes: TranslationNmtcppModelTypes
  constructor(args: TranslationNmtcppArgs)
  getState(): InferenceClientState
  load(): Promise<void>
  run(input: string): Promise<QvacResponse<string>>
  runBatch(texts: string[]): Promise<string[]>
  unload(): Promise<void>
  destroy(): Promise<void>
}
