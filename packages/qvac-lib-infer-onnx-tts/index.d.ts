import { Loader } from '@qvac/infer-base'
import InferBase from '@qvac/infer-base/WeightsProvider/BaseInference'

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
 * Arguments for Supertonic TTS engine.
 * Either pass modelDir + voiceName, or explicit paths.
 */
declare interface SupertonicTTSArgs {
  opts?: Object
  loader?: Loader
  /** Base model directory (e.g. "models/supertonic"); optional if paths set */
  modelDir?: string
  /** Path to tokenizer JSON */
  tokenizerPath?: string
  /** Path to text encoder ONNX */
  textEncoderPath?: string
  /** Path to latent denoiser ONNX */
  latentDenoiserPath?: string
  /** Path to voice decoder ONNX */
  voiceDecoderPath?: string
  /** Path to voices directory */
  voicesDir?: string
  /** Voice name (e.g. "F1") - default: "F1" */
  voiceName?: string
  /** Speech speed - default: 1 */
  speed?: number
  /** Number of denoising steps - default: 5 */
  numInferenceSteps?: number
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
 * Engine is auto-detected: Supertonic if textEncoderPath or (modelDir + voiceName) is provided.
 */
declare class ONNXTTS extends InferBase {
  /**
   * Creates an instance of ONNXTTS.
   * @param args - Chatterbox args (tokenizerPath, speechEncoderPath, ...) or Supertonic args (modelDir, voiceName, ...)
   * @param config - Language and options
   */
  constructor(args: ONNXTTSArgs, config?: ONNXTTSConfig)
}

declare namespace ONNXTTS {
  export {
    ONNXTTS as default,
    ONNXTTSArgs,
    ChatterboxTTSArgs,
    SupertonicTTSArgs,
    ONNXTTSConfig
  }
}

export = ONNXTTS
