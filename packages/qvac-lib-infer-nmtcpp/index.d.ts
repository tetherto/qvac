import { QvacResponse } from "@qvac/infer-base"
import BaseInference, {
  BaseInferenceArgs,
  ReportProgressCallback,
} from "@qvac/infer-base/WeightsProvider/BaseInference"
import WeightsProvider from "@qvac/infer-base/WeightsProvider/WeightsProvider"

declare interface Loader {
  getStream: (path: string) => Promise<ReadableStream>
  getFileSize?: (path: string) => Promise<number>
  download?: (path: string, options?: {diskPath: string, progressCallback?: ReportProgressCallback}) => Promise<void>
  deleteLocal?: () => Promise<void>
}

declare interface TranslationNmtcppParams {
  dstLang: string
  srcLang: string
  [args: string]: unknown
}

declare interface TranslationNmtcppArgs extends BaseInferenceArgs {
  loader: Loader
  params: TranslationNmtcppParams
  diskPath: string
  modelName: string
  [args: string]: unknown
}

declare interface TranslationNmtcppModelTypes {
  readonly IndicTrans: "IndicTrans"
  readonly Opus: "Opus"
  readonly Bergamot: "Bergamot"
}

declare interface TranslationNmtcppConfig {
  modelType: TranslationNmtcppModelTypes[keyof TranslationNmtcppModelTypes];
  srcVocabPath?: string  // Optional path to source vocabulary file (for Bergamot)
  dstVocabPath?: string  // Optional path to destination vocabulary file (for Bergamot)
  srcVocabName?: string  // Optional name of source vocab file to download from Hyperdrive (for Bergamot)
  dstVocabName?: string  // Optional name of destination vocab file to download from Hyperdrive (for Bergamot)
  [args: string]: unknown
}

/**
 * GGML client implementation for Marian/IndicTrans translation model
 */
declare class TranslationNmtcpp extends BaseInference {
  protected _config: TranslationNmtcppConfig
  protected _diskPath: string
  protected _modelName: string
  protected weightsProvider: WeightsProvider
  static readonly ModelTypes: TranslationNmtcppModelTypes

  modelType: TranslationNmtcppModelTypes[keyof TranslationNmtcppModelTypes]

  /**
   * Creates an instance of TranslationNmtcpp.
   * @constructor
   * @param {TranslationNmtcppArgs} args arguments for inference setup
   * @param {TranslationNmtcppConfig} config - environment specific inference setup configuration
   */
  constructor(args: TranslationNmtcppArgs, config: TranslationNmtcppConfig)

  /**
   * Loads the TranslationNmtcpp model files.
   * @param {boolean} [close=false] - Optional boolean to close the loader after it finish (default: false).
   * @param {ReportProgressCallback} [reportProgressCallback] - Optional callback function for reporting progress.
   * @returns {Promise<void>} - A promise that resolves when the model is fully loaded.
   */
  load(
      close?: boolean,
      reportProgressCallback?: ReportProgressCallback
  ): Promise<void>

  /**
   * Runs the process of inference output for a given input
   * @param {string} input - The input text to translate
   * @returns {Promise<QvacResponse>} - A promise that resolves with the response object
   */
  run(input: string): Promise<QvacResponse>
}

declare namespace TranslationNmtcpp {
  export { TranslationNmtcppArgs, TranslationNmtcppConfig }
}

export = TranslationNmtcpp;
