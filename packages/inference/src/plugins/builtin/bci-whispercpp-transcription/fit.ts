import type { BciFitRequest } from '@qvac/bci-whispercpp'

import { gpuLayersFromGate } from '@/model-fit/gpu'
import { audioSeconds, decoderCount } from '@/plugins/builtin/asr-ggml/fit'
import type { BciConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

/** The BCI fit request for a load, with its embedder and decoder count. */
export function bciFitRequest(load: FitLoad): FitRequestPlan {
  const config = (load.modelConfig ?? {}) as BciConfig
  const embedderPath = load.artifacts?.['embedderPath']
  const whisper = config.whisperConfig
  const decoders = decoderCount([whisper?.beamSize, whisper?.greedyBestOf])
  const seconds = audioSeconds(whisper?.durationMs)

  const request: BciFitRequest = {
    modelPath: load.modelPath,
    ...(embedderPath !== undefined && { embedderPath }),
    // The load runs on the GPU unless told otherwise.
    gpuLayers: gpuLayersFromGate(config.contextParams?.useGpu ?? true),
    ...(config.contextParams?.gpuDevice !== undefined && {
      gpuDevice: config.contextParams.gpuDevice
    }),
    ...(decoders !== undefined && { decoders }),
    ...(seconds !== undefined && { audioSeconds: seconds })
  }
  return { request }
}
