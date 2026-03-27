import { Loader } from '@qvac/infer-base'
import InferBase from '@qvac/infer-base/WeightsProvider/BaseInference'
import type QvacResponse from '@qvac/infer-base/src/QvacResponse'

/**
 * Arguments for Chatterbox TTS engine
 */
declare interface ChatterboxTTSArgs {
  opts?: Object
  loader?: Loader
  /** Path to tokenizer JSON file */
  tokenizerPath: string
  /** Path to speech encoder ONNX model */
  speechEncoderPath: string
  /** Path to embed tokens ONNX model */
  embedTokensPath: string
  /** Path to conditional decoder ONNX model */
  conditionalDecoderPath: string
  /** Path to language model ONNX model */
  languageModelPath: string
  /** Reference audio (Float32Array) for voice cloning */
  referenceAudio?: Float32Array | number[]
  /** Defer ONNX session creation until first use. Defaults to true on iOS, false otherwise. */
  lazySessionLoading?: boolean
  cache?: string
  logger?: Object
}

/**
 * Arguments for Supertone / Supertonic TTS (official 4-ONNX + unicode_indexer + voice_styles JSON).
 * Either pass modelDir + voiceName, or explicit ONNX/JSON paths.
 */
declare interface SupertonicTTSArgs {
  opts?: Object
  loader?: Loader
  /** Base model directory (HF Supertone/supertonic English layout: onnx/, voice_styles/) */
  modelDir?: string
  textEncoderPath?: string
  durationPredictorPath?: string
  vectorEstimatorPath?: string
  vocoderPath?: string
  unicodeIndexerPath?: string
  ttsConfigPath?: string
  voiceStyleJsonPath?: string
  /** Voice id matching voice_styles/{voiceName}.json — default: "F1" */
  voiceName?: string
  /** Speech speed — default: 1 */
  speed?: number
  /** Diffusion steps — default: 5 */
  numInferenceSteps?: number
  /** Set false for English-only models (no &lt;lang&gt; tags). Default: true */
  supertonicMultilingual?: boolean
  cache?: string
  logger?: Object
}

/**
 * Unified TTS arguments - Chatterbox or Supertonic (auto-detected by presence of textEncoderPath or modelDir+voiceName)
 */
declare type ONNXTTSArgs = ChatterboxTTSArgs | SupertonicTTSArgs

declare interface ONNXTTSConfig {
  /** Language code (e.g., "en", "es", "fr") - default: "en" */
  language?: string
  /** Whether to use GPU acceleration (Chatterbox) */
  useGPU?: boolean
}

/**
 * ONNX client implementation for TTS model.
 * Supports Chatterbox and Supertonic engines.
 * Engine is auto-detected: Supertone if textEncoderPath, durationPredictorPath, or (modelDir + voiceName) is provided.
 */
declare class ONNXTTS extends InferBase {
  /**
   * Creates an instance of ONNXTTS.
   * @param args - Chatterbox args (tokenizerPath, speechEncoderPath, ...) or Supertonic args (modelDir, voiceName, ...)
   * @param config - Language and options
   */
  constructor(args: ONNXTTSArgs, config?: ONNXTTSConfig)

  /**
   * Run text-to-speech inference. When `opts.stats` was set on construction, `response.stats` matches {@link ONNXTTS.RuntimeStats}.
   */
  run(input: ONNXTTS.TTSRunInput): Promise<QvacResponse<ONNXTTS.TTSOutputChunk>>
}

declare namespace ONNXTTS {
  /**
   * Keys returned by the native addon `TTSModel::runtimeStats()` when stats are enabled.
   */
  export interface RuntimeStats {
    /** Wall-clock inference time in seconds */
    totalTime: number
    tokensPerSecond: number
    realTimeFactor: number
    /** Duration of synthesized audio in milliseconds */
    audioDurationMs: number
    totalSamples: number
  }

  export interface TTSOutputChunk {
    outputArray: ArrayBuffer
  }

  export type TTSRunInput = {
    type?: string
    input: string
  }

  export {
    ONNXTTS as default,
    ONNXTTSArgs,
    ChatterboxTTSArgs,
    SupertonicTTSArgs,
    ONNXTTSConfig,
    RuntimeStats,
    TTSOutputChunk,
    TTSRunInput
  }
}

export = ONNXTTS
