import { Loader } from '@qvac/infer-base'
import InferBase from '@qvac/infer-base/WeightsProvider/BaseInference'

/**
 * Arguments for Piper TTS engine
 */
declare interface PiperTTSArgs {
  opts: Object
  loader?: Loader
  /** Path to the Piper ONNX model file */
  mainModelUrl: string
  /** Path to the Piper config JSON file */
  configJsonPath: string
  /** Path to eSpeak-ng data directory */
  eSpeakDataPath: string
  cache?: string
}

/**
 * Arguments for Chatterbox TTS engine
 */
declare interface ChatterboxTTSArgs {
  opts: Object
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
  cache?: string
}

/**
 * Unified TTS arguments - supports both Piper and Chatterbox
 * Engine is automatically selected based on which config fields are provided
 */
declare type ONNXTTSArgs = PiperTTSArgs | ChatterboxTTSArgs

declare interface ONNXTTSConfig {
  /** Language code (e.g., "en", "es", "fr") - default: "en" */
  language?: string
  /** Whether to use GPU acceleration */
  useGPU?: boolean
}

/**
 * ONNX client implementation for TTS model
 * Supports both Piper and Chatterbox engines
 * 
 * Engine selection is automatic based on config:
 * - Piper: Provide mainModelUrl, configJsonPath, eSpeakDataPath
 * - Chatterbox: Provide tokenizerPath, speechEncoderPath, embedTokensPath, etc.
 */
declare class ONNXTTS extends InferBase {
  /**
   * Creates an instance of ONNXTTS.
   * @constructor
   * @param args - Arguments for inference setup (Piper or Chatterbox)
   * @param config - Arguments for configuring TTS model
   */
  constructor(args: ONNXTTSArgs, config?: ONNXTTSConfig)
}

declare namespace ONNXTTS {
  export { ONNXTTS as default, ONNXTTSArgs, PiperTTSArgs, ChatterboxTTSArgs, ONNXTTSConfig }
}

export = ONNXTTS
