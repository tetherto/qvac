import type {
  MossTranscribeFitRequest,
  ParakeetFitRequest,
  WhisperFitRequest
} from '@qvac/asr-ggml'

import { gpuLayersFromGate } from '@/model-fit/gpu'
import { withCoremlLongFormDefault } from '@/plugins/builtin/asr-ggml/coreml-long-form'
import { getRuntimeContext } from '@/runtime/state'
import type { MossTranscribeConfig, ParakeetConfig, WhisperConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

/**
 * The longest single transcribe the projection has to cover. Whisper's KV cache
 * and decode graph are sized from it; unset leaves the engine's own default,
 * which is the worst case it supports.
 */
export function audioSeconds(durationMs: number | undefined): number | undefined {
  if (durationMs === undefined || durationMs <= 0) return undefined
  return durationMs / 1000
}

/**
 * Worst-case resident decoders. Each strategy carries its own count, and `-1`
 * is the engine's "use the default" sentinel, not a number of decoders.
 */
export function decoderCount(candidates: readonly (number | undefined)[]): number | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate > 0) return candidate
  }
  return undefined
}

/** The MOSS-Transcribe fit request for a load, sized by the declared recording. */
export function mossTranscribeFitRequest(load: FitLoad): FitRequestPlan {
  const workload = load.transcriptionWorkload
  if (workload === undefined) {
    return { unknown: 'a MOSS projection needs a transcriptionWorkload with its audioSeconds' }
  }

  const config = (load.modelConfig ?? {}) as MossTranscribeConfig
  const request: MossTranscribeFitRequest = {
    engine: 'moss-transcribe',
    modelPath: load.modelPath,
    audioSeconds: workload.audioSeconds,
    ...(workload.prompt !== undefined && { prompt: workload.prompt }),
    ...(workload.hotwords !== undefined && { hotwords: workload.hotwords }),
    ...(workload.maxNewTokens !== undefined && { maxNewTokens: workload.maxNewTokens }),
    gpuLayers: gpuLayersFromGate(config.useGPU),
    // An explicit selector projects on that device and overrides the GPU gate,
    // as it does at load; a missing device rejects the fit.
    ...(config.backend !== undefined && { backend: config.backend }),
    ...(config.maxThreads !== undefined && { threads: config.maxThreads }),
    ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir })
  }
  return { request }
}

/** The Whisper fit request for a load, with its VAD model and decoder count. */
export function whisperFitRequest(load: FitLoad): FitRequestPlan {
  const config = (load.modelConfig ?? {}) as WhisperConfig
  const vadModelPath = load.artifacts?.['vadModelPath']
  const decoders = decoderCount([
    config.strategy === 'beam_search' ? config.beam_search_beam_size : config.greedy_best_of
  ])
  const seconds = audioSeconds(config.duration_ms)

  const request: WhisperFitRequest = {
    engine: 'whisper',
    modelPath: load.modelPath,
    gpuLayers: gpuLayersFromGate(config.contextParams?.use_gpu),
    ...(vadModelPath !== undefined && { vadModelPath }),
    ...(config.contextParams?.flash_attn !== undefined && {
      flashAttn: config.contextParams.flash_attn
    }),
    ...(config.contextParams?.gpu_device !== undefined && {
      gpuDevice: config.contextParams.gpu_device
    }),
    ...(decoders !== undefined && { decoders }),
    ...(seconds !== undefined && { audioSeconds: seconds })
  }
  return { request }
}

/**
 * The encoder's left context and Sortformer's rolling history size its live
 * state, and the fit request measures that state in frames while the load sets
 * it in milliseconds. Converting needs the model's frame rate, a property of
 * the checkpoint, so a streaming load that pins either is not projected.
 */
const UNREPRESENTABLE_STREAMING: readonly (keyof ParakeetConfig)[] = [
  'streamingLeftContextMs',
  'streamingHistoryMs'
]

/** The Parakeet fit request for a load, covering its live session when it streams. */
export function parakeetFitRequest(
  load: FitLoad,
  platform: string | undefined = getRuntimeContext().platform
): FitRequestPlan {
  // The same long-form default the load applies, so the projection sizes the
  // encoder pass the engine will run.
  const config = withCoremlLongFormDefault(
    (load.modelConfig ?? {}) as ParakeetConfig,
    load.modelPath,
    platform
  )

  if (config.streaming === true) {
    for (const key of UNREPRESENTABLE_STREAMING) {
      if (config[key] !== undefined) return { unknown: `the fitter cannot represent ${key}` }
    }
  }

  // The addon projects one model, and a speaker-attributed load holds two,
  // so a one-model verdict would understate it.
  if (config.speakerAttribution !== undefined) {
    return {
      unknown:
        'the fitter projects one model; assess the speaker-attribution diarization model as its own load'
    }
  }

  const request: ParakeetFitRequest = {
    engine: 'parakeet',
    modelPath: load.modelPath,
    gpuLayers: gpuLayersFromGate(config.useGPU),
    // An explicit selector projects on that device and overrides the GPU gate,
    // as it does at load; a missing device rejects the fit.
    ...(config.backend !== undefined && { backend: config.backend }),
    ...(config.maxThreads !== undefined && { threads: config.maxThreads }),
    // The long-form window bounds the offline encoder graph the projection
    // sizes, so an explicit window (or the one-pass sentinel) reaches the fit.
    ...(config.longFormWindowFrames !== undefined && {
      longFormWindowFrames: config.longFormWindowFrames
    }),
    ...(config.longFormContextFrames !== undefined && {
      longFormContextFrames: config.longFormContextFrames
    }),
    // Only a streaming load holds a live session, so outside one the chunk
    // cadence describes no allocation the projection should cover.
    ...(config.streaming === true &&
      config.streamingChunkMs !== undefined && { nemotronChunkMs: config.streamingChunkMs })
  }
  return { request }
}
