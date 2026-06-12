import QvacResponse from './src/QvacResponse'

declare interface BaseInferenceArgs {
  opts?: {
    stats?: boolean
  }
  loader?: Loader
  addon?: {
    loadWeights?: (params: {
      filename: string
      contents?: Buffer
      completed: boolean
    }) => Promise<void>
    unload?: () => Promise<void>
    destroyInstance?: () => Promise<void>
    pause?: () => Promise<void>
    activate?: () => Promise<void>
    stop?: () => Promise<void>
    status?: () => Promise<any>
    append?: (input: { type: string; input?: string }) => Promise<string>
    cancel?: (jobId: string) => Promise<void>
  }
  logger?: any
}

declare interface ProgressData {
  action: 'loadingFile' | 'completeFile'
  totalSize: number
  totalFiles: number
  filesProcessed: number
  currentFile: string
  currentFileProgress: string
  overallProgress: string
}

declare interface Loader {
  getStream: (path: string) => Promise<AsyncIterable<Buffer>>
  getFileSize?: (filepath: string) => Promise<number>
  download?: (path: string, opts?: { diskPath?: string; progressReporter?: any; }) => Promise<{ await: () => Promise<any> } | false>
  deleteLocal?: () => Promise<void>
}

declare type ReportProgressCallback = (progressData: ProgressData) => void

declare type InferenceClientState = {
  configLoaded: boolean
  weightsLoaded: boolean
  destroyed: boolean
}

/**
 * Base class for inference client implementations
 */
declare class BaseInference {
  protected opts: Object
  protected logger: any
  protected loader: Loader | null
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

  /**
   * Loads the model weights from the provided loader.
   * @param loader Loader to fetch model weights from.
   * @param close Optional boolean to close the loader after it finishes.
   * @param reportProgressCallback Optional callback for reporting progress.
   */
  loadWeights(
    loader: Loader,
    close?: boolean,
    reportProgressCallback?: ReportProgressCallback
  ): Promise<void>

  _loadWeights(
    loader: Loader,
    close?: boolean,
    reportProgressCallback?: ReportProgressCallback
  ): Promise<void>

  /**
   * Unloads the model weights from memory.
   */
  unloadWeights(): Promise<void>
  _unloadWeights(): Promise<void>

  /**
   * Downloads the model weights from the provided loader.
   * @param source source to fetch model weights from.
   * @param diskPath path to download the weights to.
   * @param reportProgressCallback Optional callback for reporting progress.
   */
  downloadWeights(
    source: any,
    diskPath?: string,
    reportProgressCallback?: ReportProgressCallback
  ): Promise<void>

  _downloadWeights(
    source: any,
    diskPath?: string,
    reportProgressCallback?: ReportProgressCallback
  ): Promise<void>

  /**
   * Initializes progress reporting for model loading
   */
  initProgressReport(
    weightFiles: string[],
    callbackFunction: ReportProgressCallback
  ): Promise<any>

  /**
   * Downloads the model files.
   * @param progressReport Optional progress report instance.
   */
  download(progressReport?: any): Promise<void>

  /**
   * Deletes local model files
   */
  delete(): Promise<void>

  /**
   * Gets configuration files content
   */
  _getConfigs(): Promise<Record<string, Buffer>>

  /**
   * Gets file content from loader
   * @param filepath Path to the file.
   */
  _getFileContent(filepath: string): Promise<Buffer>

  /**
   * Gets configuration file paths
   */
  _getConfigPathNames(): string[]

  /**
   * Internal method to run inference
   * @param input Input data for inference.
   */
  _runInternal(input: any): Promise<QvacResponse>

  /**
   * Creates addon instance with the provided interface and args
   */
  _createAddon(AddonInterface: any, ...args: any[]): any

  /**
   * Creates a response instance for a job
   * @param jobId Job identifier.
   */
  _createResponse(jobId: string): QvacResponse

  /**
   * Handles output callbacks from the inference process
   * @param addon The addon instance.
   * @param event Event type ('Error' | 'Output' | 'JobEnded').
   * @param jobId Job identifier.
   * @param data Event data.
   * @param error Error if any.
   */
  _outputCallback(
    addon: any,
    event: 'Error' | 'Output' | 'JobEnded',
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
  _saveJobToResponseMapping(jobId: string, response: QvacResponse): void

  /**
   * Deletes job mapping.
   * @param jobId Job identifier.
   */
  _deleteJobMapping(jobId: string): void

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
   * Gets the current status
   */
  status(): Promise<any>
}

/**
 * Creates a serialized execution queue. Calls to the returned function
 * run one at a time, in order, even when fired concurrently.
 */
declare function exclusiveRunQueue(): (fn: () => Promise<any>) => Promise<any>

/**
 * Returns the graphics API identifier for the current platform.
 * Falls back to 'vulkan' on unknown platforms.
 */
declare function getApiDefinition(): string

declare interface JobHandler {
  /** Creates a new QvacResponse and stores it as active. Fails any stale active response. */
  start(): QvacResponse
  /** Registers a pre-built response (e.g. a custom subclass) as active. Fails any stale active response. */
  startWith(response: QvacResponse): QvacResponse
  /** Routes output data to the active response. No-op if idle. */
  output(data: any): void
  /** Ends the active response. Optionally forwards stats before ending. */
  end(stats?: any, result?: any): void
  /** Fails the active response with an error. */
  fail(error: Error | string): void
  /** The current active QvacResponse, or null if idle. */
  readonly active: QvacResponse | null
}

/**
 * Creates a single-job handler that manages the lifecycle of a QvacResponse.
 * Replaces the _jobToResponse Map / _saveJobToResponseMapping / _deleteJobMapping boilerplate.
 */
declare function createJobHandler(opts: { cancel: () => void | Promise<void> }): JobHandler

declare namespace BaseInference {
  export {
    BaseInference as default,
    BaseInferenceArgs,
    ProgressData,
    InferenceClientState,
    Loader,
    ReportProgressCallback,
    QvacResponse,
    exclusiveRunQueue,
    getApiDefinition,
    createJobHandler,
    JobHandler
  }
}

export = BaseInference
