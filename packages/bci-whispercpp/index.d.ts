import QvacResponse from '@qvac/infer-base/src/QvacResponse'
import type { LoggerInterface } from '@qvac/logging'

declare interface BCIConfig {
  /**
   * Session day index used to select day-specific projection matrices in
   * bci-embedder.bin.
   *
   *   - `day_idx >= 0` (default `0`): apply the day projection; values beyond
   *     the available range are clamped at the native layer.
   *   - `day_idx === -1`: mel passthrough — skip preprocessing and treat
   *     the input buffer as pre-computed 512-bin mel features in
   *     frame-major layout. Intended for parity testing against the Python
   *     reference, not production use.
   */
  day_idx?: number
}

declare interface WhisperConfig {
  language?: string
  n_threads?: number
  temperature?: number
  suppress_nst?: boolean
  suppress_blank?: boolean
  duration_ms?: number
  translate?: boolean
  no_timestamps?: boolean
  single_segment?: boolean
  print_special?: boolean
  print_progress?: boolean
  print_realtime?: boolean
  print_timestamps?: boolean
  detect_language?: boolean
  greedy_best_of?: number
  beam_search_beam_size?: number
}

declare interface BCIWhispercppFiles {
  /** Absolute path to the BCI GGML model file. */
  model: string
}

declare interface BCIWhispercppArgs {
  files: BCIWhispercppFiles
  logger?: LoggerInterface
  opts?: {
    stats?: boolean
  }
}

declare interface BCIWhispercppConfig {
  whisperConfig?: WhisperConfig
  bciConfig?: BCIConfig
  contextParams?: {
    model?: string
    use_gpu?: boolean
    flash_attn?: boolean
    gpu_device?: number
  }
  miscConfig?: {
    caption_enabled?: boolean
  }
}

declare interface TranscriptSegment {
  text: string
  toAppend: boolean
  start: number
  end: number
  id: number
}

declare interface BCIWhispercppState {
  configLoaded: boolean
  destroyed: boolean
}

/**
 * BCI neural signal transcription client powered by whisper.cpp.
 *
 * Uses `createJobHandler` + `exclusiveRunQueue` from `@qvac/infer-base` and
 * follows the same lifecycle contract as `TranscriptionWhispercpp` /
 * `LlmLlamacpp`: construct with local file paths, call `load()`, issue
 * `transcribe()` / `transcribeFile()` calls, then `destroy()`.
 */
declare class BCIWhispercpp {
  constructor(args: BCIWhispercppArgs, config?: BCIWhispercppConfig)

  /** Load and activate the model. Must be awaited before `transcribe()`. */
  load(): Promise<void>

  /** Transcribe a neural signal binary file (convenience wrapper). */
  transcribeFile(filePath: string): Promise<QvacResponse>

  /** Transcribe a neural signal buffer (batch mode). */
  transcribe(neuralData: Uint8Array): Promise<QvacResponse>

  /** Cancel the in-flight inference, if any. */
  cancel(): Promise<void>

  /** Unload the model and release native resources. Instance is reusable. */
  unload(): Promise<void>

  /**
   * Destroy the instance, unload, and mark as permanently destroyed.
   * Subsequent `load()` calls will throw `MODEL_NOT_LOADED`.
   */
  destroy(): Promise<void>

  /** Current lifecycle state. */
  getState(): BCIWhispercppState
}

declare namespace BCIWhispercpp {
  /**
   * Compute Word Error Rate between hypothesis and reference strings.
   * @returns WER as a ratio (0.0 = perfect).
   */
  function computeWER(hypothesis: string, reference: string): number

  export {
    BCIWhispercpp as default,
    BCIWhispercpp,
    BCIConfig,
    WhisperConfig,
    BCIWhispercppFiles,
    BCIWhispercppArgs,
    BCIWhispercppConfig,
    BCIWhispercppState,
    TranscriptSegment
  }
}

export = BCIWhispercpp
