import { Loader } from '@qvac/infer-base'
import InferBase from '@qvac/infer-base/WeightsProvider/BaseInference'

declare interface ONNXTTSArgs {
  opts: Object
  loader?: Loader
  mainModelUrl: string
  configJsonPath: string
  eSpeakDataPath: string
  cache?: string
}

declare interface ONNXTTSConfig {
  language?: string
  useGPU?: boolean
}

/**
 * ONNX client implementation for TTS model
 */
declare class ONNXTTS extends InferBase {
  /**
   * Creates an instance of ONNXBase.
   * @constructor
   * @param {ONNXTTSArgs} args arguments for inference setup
   * @param {ONNXTTSArgs} config arguments for configuring TTS model
   */
  constructor(args: ONNXTTSArgs, config?: ONNXTTSConfig)
}

declare namespace ONNXTTS {
  export { ONNXTTS as default, ONNXTTSArgs }
}

export = ONNXTTS
