import ONNXBase, {Loader} from '@qvac/infer-base'

declare interface ONNXOcrArgs {
  opts: Object
  loader: Loader
  params: {
    pathDetector: string
    pathRecognizer: string
    langList: string[]
    useGPU?: boolean
    timeout?: number
  } 
}

/**
 * ONNX client implementation for OCR model
 */
declare class ONNXOcr extends ONNXBase {
  /**
   * Creates an instance of ONNXBase.
   * @constructor
   * @param {ONNXOcrArgs} args arguments for inference setup
   */
  constructor(args: ONNXOcrArgs)
}

declare const modelClass: typeof ONNXOcr
declare const modelFile: any

export { ONNXOcr, modelClass, modelFile }
