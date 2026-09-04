export interface AudioGenConfigurationParams {
  engineType?: string
  modelDir?: string
  textEncModelPath?: string
  lmModelPath?: string
  synthModelPath?: string
  ditModelPath?: string
  vaeModelPath?: string
  inferenceSteps?: number
  shift?: number
  useGPU?: boolean
  nGpuLayers?: number
  threads?: number
  /**
   * Prebuilds root the native side scans (after appending the per-target
   * BACKENDS_SUBDIR) for dlopen'd ggml backend modules. Required on arm64, where
   * the CPU backend ships as per-microarch MODULE .so files.
   */
  backendsDir?: string
}

/** Stable string values serialized across the JS -> native addon boundary. */
export enum AudioEditOperationType {
  FlowEdit = 'flow-edit',
  Repaint = 'repaint'
}

export enum RepaintMode {
  Conservative = 'conservative',
  Balanced = 'balanced',
  Aggressive = 'aggressive'
}

export interface AudioEditOperationJobData {
  type: AudioEditOperationType
  sourceCaption?: string
  sourceLyrics?: string
  targetCaption?: string
  targetLyrics?: string
  caption?: string
  lyrics?: string
  nMin?: number
  nMax?: number
  nAvg?: number
  start?: number
  end?: number
  mode?: RepaintMode
  strength?: number
}

/** One generation job handed to the native `runJob`. */
export interface AudioGenJobData {
  type: string
  input: string
  lyrics?: string
  seed?: number
  vocalLanguage?: string
  bpm?: number
  keyscale?: string
  timesignature?: string
  augmentCaptionWithMetadata?: boolean
  duration?: number
  lmTemperature?: number
  lmTopP?: number
  lmTopK?: number
  lmCfgScale?: number
  lmPhase1?: boolean
  simpleMode?: boolean
  normalizeLoudness?: boolean
  computeQualityScore?: boolean
  dcwEnabled?: boolean
  dcwScaler?: number
  dcwHighScaler?: number
  audioCodes?: Int32Array
  referenceAudio?: Float32Array
  sourceAudio?: Float32Array
  taskType?: string
  track?: string
  guidanceScale?: number
  audioCoverStrength?: number
  coverNoiseStrength?: number
  maxFrames?: number
  inferenceSteps?: number
  cfgScale?: number
  editOperations?: AudioEditOperationJobData[]
}

/** Native output event: (handle, event, data, error). */
export type AudioGenOutputCallback = (
  handle: unknown,
  event: unknown,
  data: unknown,
  error: unknown,
) => void

/** The C++ addon surface exposed through binding.js (require.addon()). */
export interface AudioGenBinding {
  createInstance(
    owner: AudioGenInterface,
    configuration: AudioGenConfigurationParams,
    outputCallback: AudioGenOutputCallback | null,
  ): object
  activate(handle: object | null): Promise<void>
  runJob(handle: object | null, data: AudioGenJobData): boolean | Promise<boolean>
  cancel(handle: object | null): Promise<void>
  destroyInstance(handle: object): Promise<void> | void
}

/** An interface between the Bare addon in C++ and the JS runtime. */
export class AudioGenInterface {
  private readonly _binding: AudioGenBinding
  private _handle: object | null

  constructor (
    binding: AudioGenBinding,
    configuration: AudioGenConfigurationParams = {},
    outputCallback: AudioGenOutputCallback | null = null,
  ) {
    this._binding = binding
    this._handle = this._binding.createInstance(this, configuration, outputCallback)
  }

  async activate (): Promise<void> {
    return this._binding.activate(this._handle)
  }

  async runJob (data: AudioGenJobData): Promise<boolean> {
    return this._binding.runJob(this._handle, data)
  }

  async cancel (): Promise<void> {
    return this._binding.cancel(this._handle)
  }

  async destroyInstance (): Promise<void> {
    if (this._handle === null) return
    const handle = this._handle
    this._handle = null
    await this._binding.destroyInstance(handle)
  }
}
