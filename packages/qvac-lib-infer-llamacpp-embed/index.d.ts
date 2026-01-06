import BaseInference from '@qvac/infer-base/WeightsProvider/BaseInference';
import WeightsProvider from '@qvac/infer-base/WeightsProvider/WeightsProvider';
import type Logger from '@qvac/logging';
import type { QvacResponse } from '@qvac/infer-base';
import { Readable } from 'stream';

declare interface Loader {
  start(): Promise<void>
  stop(): Promise<void>
  getStream(path: string): Promise<Readable>
}

declare interface GGMLArgs {
  params: object
  loader: Loader
  opts?: object
  logger?: Logger
  diskPath: string
  modelName: string
  [key: string]: any
}

declare interface GGMLConfig {
  modelFilePath?: string
  weights: string[]
  settings: string[]
}

declare type AppendInput =
  | { type: 'text'; input: string }
  | { type: 'end of job' }

declare interface Addon {
  activate(): Promise<void>
  append(input: AppendInput): Promise<number>
  cancel(jobId: number): Promise<void>
  loadWeights?(params: {
    filename: string
    contents?: Buffer
    completed: boolean
  }): Promise<void>
}

declare interface ProgressData {
  action: string
  totalSize: number
  totalFiles: number
  filesProcessed: number
  currentFile: string
  currentFileProgress: string
  overallProgress: string
}

declare type ReportProgressCallback = (progressData: ProgressData) => void

/**
 * GGML client implementation for Bert model
 */
declare class GGMLBert extends BaseInference {
  protected _config: GGMLConfig
  protected _diskPath: string
  protected _modelName: string
  protected addon: Addon
  protected weightsProvider: WeightsProvider

  /**
   * Creates an instance of MLCBert.
   * @param args - Arguments for inference setup, including opts, loader, logger, diskPath, and modelName.
   * @param config - Environment-specific inference setup configuration.
   */
  constructor(args: GGMLArgs, config: GGMLConfig)

  /**
   * Loads the Bert model files.
   * @param {boolean} [close=true] - Optional boolean to close the loader after it finish (default: true).
   * @param {ReportProgressCallback} [reportProgressCallback] - Optional callback function for reporting progress.
   * @returns {Promise<void>} - A promise that resolves when the model is fully loaded.
   */
  load(close?: boolean, reportProgressCallback?: ReportProgressCallback): Promise<void>

  /**
   * Download the model weight files and return the local path to the primary file.
   * @param {ReportProgressCallback} [onDownloadProgress] - Callback invoked with bytes downloaded
   * @returns {Promise<{filePath: string, completed: boolean, error: boolean}[]>} Local file path for the model weights
   */
  downloadWeights(onDownloadProgress?: ReportProgressCallback, opts?: { closeLoader?: boolean }): Promise<{filePath: string, completed: boolean, error: boolean}[]>

  /**
   * Runs inference on the given text input.
   * @param {string} text - The text to process for embeddings.
   * @returns {Promise<QvacResponse>} - A promise that resolves to the inference response.
   */
  _runInternal(text: string): Promise<QvacResponse>

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {string} configurationParams.path - Local file or directory path
   * @param {Object} configurationParams.config - Configuration settings
   * @returns {Addon} The instantiated addon interface
   */
  _createAddon(configurationParams: { path: string; config: MLCConfig }): Addon
}
declare namespace GGMLBert {
    export { GGMLBert as default , GGMLArgs, GGMLConfig }
}

export = GGMLBert

