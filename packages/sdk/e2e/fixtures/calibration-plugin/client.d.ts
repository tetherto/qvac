export interface CalibrationByteRange {
  lower: number
  upper: number
}

export interface CalibrationCoefficients {
  weightUpperCoeff: number
  fixedOverheadBytes: CalibrationByteRange
  computeBufferBytesPerToken: CalibrationByteRange
  audioWindowBytes: CalibrationByteRange
  audioStreamingBytes: CalibrationByteRange
  validated: boolean
  measuredAt?: string
  measuredOn?: { backend: string; device?: string; kvElementBytes: number }
  notes?: readonly string[]
}

export interface CalibrationRunSummary {
  platform: string
  /** `<platform>` for a system-memory run, `<platform>-<backend>` for a GPU one. */
  fixtureKey: string
  pass: 'cpu' | 'gpu' | 'shared'
  /** What the engine reported executing on, across the measured points. */
  backendDevices: readonly ('cpu' | 'gpu')[]
  profile: {
    name: 'desktop' | 'mobile'
    contexts: readonly [number, number]
    fitModels: readonly string[]
    heldOutModel: string
  }
  loadMode?: 'none'
  backend: string
  device?: string
  cpuForced: boolean
  measurements: readonly {
    name: string
    contextTokens: number
    artifactBytes: number
    persistentBytes: number
    workingBytes: number
    kvBytes: number
    backendDevice?: 'cpu' | 'gpu'
  }[]
  fit: {
    weightRatio: number
    fixedBytes: number
    perTokenBytes: number
    worstExcessBytes: number
  }
  calibration: CalibrationCoefficients
  heldOut: {
    model: string
    contextTokens: number
    worstTotalBytes: number
    predictedUpperBytes: number
    holds: boolean
  }
  warnings: readonly string[]
  fixtureSource: string
}

export type CalibrationChunk =
  | { type: 'log'; line: string }
  | { type: 'aborted'; reason: string; message: string }
  | { type: 'result'; run: CalibrationRunSummary }

export declare function calibrate(modelId: string): AsyncGenerator<CalibrationChunk>
