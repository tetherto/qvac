import type { QvacResponse } from '@qvac/infer-base'

export interface OcrGgmlParams {
  /** Path to the CRAFT detector GGUF file. */
  pathDetector: string
  /** Path to the recognizer GGUF file (e.g. english_g2.gguf). */
  pathRecognizer: string
  /** Languages handled by the recognizer (e.g. `['en']`, `['en', 'fr']`). */
  langList: string[]

  /** Detection magnification ratio. Default: 1.5. */
  magRatio?: number
  /** Rotation angles tried when the primary pass is low-confidence. Default: [90, 270]. */
  defaultRotationAngles?: number[]
  /** Retry low-confidence boxes with contrast adjustment. Default: false. */
  contrastRetry?: boolean
  /** Threshold below which contrast-retry kicks in. Default: 0.4. */
  lowConfidenceThreshold?: number
  /** Recognizer batch size. Default: 32. */
  recognizerBatchSize?: number
  /**
   * GGML CPU thread count:
   *   - `0` (default): auto-detect physical cores (hardware_concurrency / 2, floor 1)
   *   - `> 0`: explicit override
   *   - `< 0`: leave GGML's CPU backend default unchanged
   */
  nThreads?: number
  /** Directory holding ggml backend shared libraries. Default: `<package>/prebuilds`. */
  backendsDir?: string
}

export interface OcrGgmlArgs {
  params: OcrGgmlParams
  opts?: { stats?: boolean }
  logger?: any
}

export interface OcrGgmlRunOptions {
  /** Merge nearby boxes into paragraph-style regions. Default: false. */
  paragraph?: boolean
  /** Extra padding around detected boxes, as a fraction of box size. Default: 0.1. */
  boxMarginMultiplier?: number
  /** Override `defaultRotationAngles` for this single call. */
  rotationAngles?: number[]
}

export interface OcrGgmlRunInput {
  /** Path to a JPEG, PNG, or BMP file. */
  path: string
  options?: OcrGgmlRunOptions
}

/**
 * One detected text region. Shape matches `@qvac/ocr-onnx` so downstream
 * consumers can swap backends without changing data handling code.
 */
export type InferredText = [
  /** Bounding box: [[x,y], [x,y], [x,y], [x,y]]. */
  [[number, number], [number, number], [number, number], [number, number]],
  /** Recognized text. */
  string,
  /** Confidence in [0, 1]. */
  number
]

export interface InferenceClientState {
  configLoaded: boolean
  weightsLoaded: boolean
  destroyed: boolean
}

export interface RuntimeStats {
  /** Total wall-clock time for the run (seconds). */
  totalTime: number
  /** Detection step duration (seconds). */
  detectionTime: number
  /** Recognition step duration (seconds). */
  recognitionTime: number
  /** Number of detected boxes (aligned + unaligned). */
  numBoxes: number
}

export default class OcrGgml {
  constructor(args: OcrGgmlArgs)
  getState(): InferenceClientState
  load(): Promise<void>
  run(input: OcrGgmlRunInput): Promise<QvacResponse<InferredText[]>>
  unload(): Promise<void>
  destroy(): Promise<void>

  static readonly inferenceManagerConfig: { noAdditionalDownload: boolean }
  static getModelKey(): string
}
