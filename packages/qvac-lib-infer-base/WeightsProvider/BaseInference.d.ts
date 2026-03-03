import QvacResponse from '../src/QvacResponse'
import QvacLogger from '@qvac/logging'

declare interface ProgressData {
  action: 'loadingFile' | 'completeFile'
  totalSize: number
  totalFiles: number
  filesProcessed: number
  currentFile: string
  currentFileProgress: string
  overallProgress: string
}

declare type ReportProgressCallback = (progressData: ProgressData) => void

declare interface BaseInferenceArgs {
  opts?: {
    stats?: boolean
  }
  addon?: {
    unload?: () => Promise<void>
    destroyInstance?: () => Promise<void>
    pause?: () => Promise<void>
    activate?: () => Promise<void>
    stop?: () => Promise<void>
    status?: () => Promise<any>
    append?: (input: { type: string; input?: string }) => Promise<string>
    cancel?: (jobId: string) => Promise<void>
  }
  logger?: QvacLogger
}

declare type DownloadWeightsOptions = {
  closeLoader?: boolean
} & Record<string, any>

declare type InferenceClientState = {
  configLoaded: boolean
  weightsLoaded: boolean
  destroyed: boolean
}

/**
 * Base class for inference client implementations
 */
declare class BaseInference {
  protected opts: { stats?: boolean }
  protected logger: QvacLogger
  protected addon: any
  protected _jobToResponse: Map<string, QvacResponse>

  /**
   * Creates an instance of BaseInference.
   * @param {BaseInferenceArgs} args arguments for inference setup
   */
  constructor(args: BaseInferenceArgs)

  /**
   * Returns the current state of the inference client.
   */
  getState(): InferenceClientState

  /**
   * Identifies which model API should be used on current environment.
   */
  getApiDefinition(): string

  /**
   * Supplies model and all the required files to the addon.
   * If a model is already loaded, this will automatically call unload() first.
   * @param args forwarded to your implementation of _load
   */
  load(...args: any[]): Promise<void>

  /**
   * Subclasses implement this to perform their own loading logic.
   * @param args arguments passed through from load(...)
   */
  _load(...args: any[]): Promise<void>

  downloadWeights (onDownloadProgress: (progress: Record<string, any>, opts: DownloadWeightsOptions) => {}): Promise<any> 

  _downloadWeights (onDownloadProgress: (progress: Record<string, any>, opts: DownloadWeightsOptions) => {}): Promise<any>
  /**
   * Deletes local model files
   */
  delete(): Promise<void>

  /**
   * Internal method to run inference
   * @param input Input data for inference.
   */
  protected _runInternal(input: any): Promise<QvacResponse>

  /**
   * Creates addon instance with the provided interface and args
   */
  protected _createAddon(AddonInterface: any, ...args: any[]): any

  /**
   * Creates a response instance for a job
   * @param jobId Job identifier.
   */
  protected _createResponse(jobId: string): QvacResponse

  /**
   * Handles output callbacks from the inference process
   * @param addon The addon instance.
   * @param event Event type ('Error' | 'Output' | 'FinetuneProgress' | 'JobEnded').
   * @param jobId Job identifier.
   * @param data Event data.
   * @param error Error if any.
   */
  protected _outputCallback(
    addon: any,
    event: 'Error' | 'Output' | 'FinetuneProgress' | 'JobEnded',
    jobId: string,
    data: any,
    error?: Error
  ): void

  /**
   * Runs the process of inference output for a given input.
   * @param input Data for an inference in the supported format.
   */
  run(input: any): Promise<QvacResponse>

  /**
   * Saves job to response mapping.
   * @param jobId Job identifier.
   * @param response Response instance.
   */
  protected _saveJobToResponseMapping(jobId: string, response: QvacResponse): void

  /**
   * Deletes job mapping.
   * @param jobId Job identifier.
   */
  protected _deleteJobMapping(jobId: string): void

  /**
   * Unloads the configuration and weights from memory.
   */
  unload(): Promise<void>

  /**
   * Unloads the model and all associated resources, making it unusable.
   */
  destroy(): Promise<void>

  /**
   * Pauses the inference process
   */
  pause(): Promise<void>

  /**
   * Unpauses the inference process
   */
  unpause(): Promise<void>

  /**
   * Stops the inference process
   */
  stop(): Promise<void>

  /**
   * Cancels a running job(s)
   * @param jobId Job identifier, if no ID is provided, all jobs will be cancelled
   */
  cancel(jobId?: string): Promise<void>

  /**
   * Gets the current status
   */
  status(): Promise<any>
}

declare namespace BaseInference {
  export {
    BaseInference as default,
    BaseInferenceArgs,
    ProgressData,
    InferenceClientState,
    ReportProgressCallback
  }
}

export = BaseInference
