import type { QvacResponse } from '@qvac/infer-base'

/**
 * OCR pipeline backing the addon.
 *   - `easyocr` (default): CRAFT detector + CRNN gen-2 recognizer.
 *     Uses `langList`, `magRatio`, `defaultRotationAngles`, `contrastRetry`,
 *     `lowConfidenceThreshold`, `recognizerBatchSize`.
 *   - `doctr`: DBNet detector + doctr recognizer.
 *     Language-agnostic; EasyOCR-specific knobs (`magRatio`, etc.) are
 *     ignored.
 */
export type OcrGgmlPipelineType = 'easyocr' | 'doctr'

export interface OcrGgmlParams {
  /**
   * Path to the detector GGUF file.
   *   - easyocr: CRAFT model (e.g. `craft_mlt_25k.gguf`)
   *   - doctr:   DBNet model (e.g. `db_mobilenet_v3_large.gguf`)
   */
  pathDetector: string
  /**
   * Path to the recognizer GGUF file.
   *   - easyocr: CRNN gen-2 (e.g. `english_g2.gguf`, `latin_g2.gguf`)
   *   - doctr:   doctr recognition model (e.g. `crnn_mobilenet_v3_small.gguf`)
   */
  pathRecognizer: string
  /** Languages handled by the recognizer (e.g. `['en']`, `['en', 'fr']`). */
  langList: string[]

  /** Pipeline backing the addon. Default: `'easyocr'`. */
  pipelineType?: OcrGgmlPipelineType
  /** Detection magnification ratio (easyocr only). Default: 1.5. */
  magRatio?: number
  /** Rotation angles tried when the primary pass is low-confidence (easyocr only). Default: [90, 270]. */
  defaultRotationAngles?: number[]
  /** Retry low-confidence boxes with contrast adjustment (easyocr only). Default: false. */
  contrastRetry?: boolean
  /** Threshold below which contrast-retry kicks in (easyocr only). Default: 0.4. */
  lowConfidenceThreshold?: number
  /** Recognizer batch size (easyocr only). Default: 32. */
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

export class OcrGgml {
  constructor(args: OcrGgmlArgs)
  getState(): InferenceClientState
  load(): Promise<void>
  run(input: OcrGgmlRunInput): Promise<QvacResponse<InferredText[]>>
  unload(): Promise<void>
  destroy(): Promise<void>

  static readonly inferenceManagerConfig: { noAdditionalDownload: boolean }
  static getModelKey(): string
}

export const modelClass: typeof OcrGgml
export const modelFile: unknown

export const ERR_CODES: {
  readonly FAILED_TO_LOAD_WEIGHTS: number
  readonly FAILED_TO_CANCEL: number
  readonly FAILED_TO_RUN_JOB: number
  readonly FAILED_TO_GET_STATUS: number
  readonly FAILED_TO_DESTROY: number
  readonly FAILED_TO_ACTIVATE: number
  readonly MISSING_REQUIRED_PARAMETER: number
  readonly UNSUPPORTED_LANGUAGE: number
  readonly INVALID_IMAGE_OR_INSUFFICIENT_DATA: number
  readonly UNSUPPORTED_IMAGE_FORMAT: number
  readonly NOT_LOADED: number
}

export class QvacErrorAddonOcrGgml extends Error {
  code: number
}

export const binding: unknown
export const addonLogging: unknown
