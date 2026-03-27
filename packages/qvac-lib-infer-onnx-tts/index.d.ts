import { Loader } from '@qvac/infer-base'
import InferBase from '@qvac/infer-base/WeightsProvider/BaseInference'
import type QvacResponse from '@qvac/infer-base/src/QvacResponse'

/**
 * Weight / config paths for ONNX TTS. Use short keys; legacy `*Path` names and
 * SDK aliases (`supertonicModel`, `latentDenoiser`, `voiceDecoder`, `supertonicVocoder`) are accepted.
 */
declare interface ONNXTTSFiles {
  /** Supertonic: HF layout root (`onnx/`, `voice_styles/`). */
  modelDir?: string
  /** Chatterbox: tokenizer JSON. Supertonic explicit: may serve as unicode indexer if `unicodeIndexer` omitted. */
  tokenizer?: string
  speechEncoder?: string
  embedTokens?: string
  conditionalDecoder?: string
  languageModel?: string
  /** Alias: `supertonicModel` */
  textEncoder?: string
  supertonicModel?: string
  /** Aliases: `latentDenoiser`, `*Path` variants */
  durationPredictor?: string
  latentDenoiser?: string
  vectorEstimator?: string
  /** Aliases: `voiceDecoder`, `supertonicVocoder`, `*Path` variants */
  vocoder?: string
  voiceDecoder?: string
  supertonicVocoder?: string
  unicodeIndexer?: string
  ttsConfig?: string
  voiceStyle?: string
  voicesDir?: string
  tokenizerPath?: string
  speechEncoderPath?: string
  embedTokensPath?: string
  conditionalDecoderPath?: string
  languageModelPath?: string
  textEncoderPath?: string
  durationPredictorPath?: string
  latentDenoiserPath?: string
  vectorEstimatorPath?: string
  vocoderPath?: string
  voiceDecoderPath?: string
  unicodeIndexerPath?: string
  ttsConfigPath?: string
  voiceStyleJsonPath?: string
}

declare interface ONNXTTSRuntimeConfig {
  /** Language code (e.g. "en", "es") — default "en" */
  language?: string
  /** Chatterbox: GPU — default false */
  useGPU?: boolean
}

declare interface ONNXTTSOptions {
  files?: ONNXTTSFiles
  config?: ONNXTTSRuntimeConfig
  logger?: object
  loader?: Loader
  cache?: string
  lazySessionLoading?: boolean
  /** Chatterbox voice cloning input */
  referenceAudio?: Float32Array | number[]
  /** Supertonic — default "F1". Required with `files.modelDir` for engine detection (same as before). */
  voiceName?: string
  speed?: number
  numInferenceSteps?: number
  supertonicMultilingual?: boolean
  opts?: object
  exclusiveRun?: boolean
}

/**
 * ONNX client for TTS (Chatterbox or Supertonic). Engine is inferred from `files`
 * (same rules as before: Supertonic if text/duration paths or `modelDir` + `voiceName`).
 */
declare class ONNXTTS extends InferBase {
  constructor(options?: ONNXTTSOptions)

  /**
   * Run text-to-speech. When `opts.stats` was set, `response.stats` matches {@link ONNXTTS.RuntimeStats}.
   */
  run(input: ONNXTTS.TTSRunInput): Promise<QvacResponse<ONNXTTS.TTSOutputChunk>>
}

declare namespace ONNXTTS {
  export interface RuntimeStats {
    totalTime: number
    tokensPerSecond: number
    realTimeFactor: number
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
    ONNXTTSFiles,
    ONNXTTSOptions,
    ONNXTTSRuntimeConfig,
    RuntimeStats,
    TTSOutputChunk,
    TTSRunInput
  }
}

export = ONNXTTS
