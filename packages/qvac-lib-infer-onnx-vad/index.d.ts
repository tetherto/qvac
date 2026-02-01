import ONNXBase from '@tetherto/infer-onnx-base'

declare interface VADOptions {
  /** Sample rate in Hz (default: 16000, supports 16000 or 8000) */
  sampleRate?: number
  /** Window frame size in samples (default: 64, supports 256/512/768 for 8kHz, 512/1024/1536 for 16kHz) */
  windowFrameSize?: number
  /** VAD threshold for speech detection (default: 0.5) */
  threshold?: number
  /** Minimum silence duration in milliseconds (default: 0) */
  minSilenceDurationMs?: number
  /** Speech padding in milliseconds (default: 64) */
  speechPadMs?: number
  /** Minimum speech duration in milliseconds (default: 64) */
  minSpeechDurationMs?: number
  /** Maximum speech duration in seconds (default: infinity) */
  maxSpeechDurationS?: number
  /** Number of inter-op threads for ONNX runtime (default: 1) */
  interThreads?: number
  /** Number of intra-op threads for ONNX runtime (default: 1) */
  intraThreads?: number
}

declare interface VADArgs {
  opts: VADOptions
  params: {
    path: string
  } 
}

/**
 * ONNX client implementation for SileroVAD (Voice Activity Detection) model
 */
declare class VAD extends ONNXBase {
  /**
   * Creates an instance of ONNXBase.
   * @constructor
   * @param {VADArgs} args arguments for inference setup
   */
  constructor(args: VADArgs)
}

declare namespace VAD {
  export { VAD as default, VADArgs, VADOptions }
}

export = VAD
