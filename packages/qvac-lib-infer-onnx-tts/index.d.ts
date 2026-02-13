import { Loader } from '@qvac/infer-base'
import InferBase from '@qvac/infer-base/WeightsProvider/BaseInference'

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
 * Unified TTS arguments - supports Chatterbox
 */
declare type ONNXTTSArgs = ChatterboxTTSArgs

declare interface ONNXTTSConfig {
  /** Language code (e.g., "en", "es", "fr") - default: "en" */
  language?: string
  /** Whether to use GPU acceleration */
  useGPU?: boolean
}

/**
 * ONNX client implementation for TTS model
 * Supports Chatterbox engine
 * 
 * Engine selection is automatic based on config:
 * - Chatterbox: Provide tokenizerPath, speechEncoderPath, embedTokensPath, etc.
 */
declare class ONNXTTS extends InferBase {
  /**
   * Creates an instance of ONNXTTS.
   * @constructor
   * @param args - Arguments for inference setup (Chatterbox)
   * @param config - Arguments for configuring TTS model
   */
  constructor(args: ONNXTTSArgs, config?: ONNXTTSConfig)
}

declare namespace ONNXTTS {
  export { ONNXTTS as default, ONNXTTSArgs, ChatterboxTTSArgs, ONNXTTSConfig }
}

export = ONNXTTS
