import type { AudiogenFitRequest } from '@qvac/audiogen-ggml'

import type { AudioGenRuntimeConfig } from '@/schemas/index'
import type { FitRequestPlan } from '@/resources/model-fit/native-probe/create-fit-request'
import { gpuLayersFromGate } from '@/resources/model-fit/native-probe/engines/gpu'

/**
 * `@qvac/audiogen-ggml` is an optional peer dependency, so its value exports
 * are unavailable to a host that ships without it. The engine discriminator is
 * matched by its literal rather than imported.
 */
const MINIMAX = 'minimax'

export interface AudiogenFitRequestParams {
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
  marginBytes?: number | undefined
}

export function createAudiogenFitRequest(params: AudiogenFitRequestParams): FitRequestPlan {
  const config = (params.modelConfig ?? {}) as AudioGenRuntimeConfig
  const artifacts = params.artifacts ?? {}

  if (config.engine === MINIMAX) {
    return { supported: false, detail: 'the minimax pipeline has no fitter' }
  }

  const textEncoderPath = artifacts['textEncModelPath']
  const lmPath = artifacts['lmModelPath']
  const ditPath = artifacts['ditModelPath']
  const vaePath = artifacts['vaeModelPath']

  if (
    textEncoderPath === undefined ||
    lmPath === undefined ||
    ditPath === undefined ||
    vaePath === undefined
  ) {
    return { supported: false, detail: 'the ace-step stage checkpoints are not all resolved' }
  }

  const layers = 'nGpuLayers' in config ? config.nGpuLayers : undefined
  const request: AudiogenFitRequest = {
    textEncoderPath,
    lmPath,
    ditPath,
    vaePath,
    gpuLayers: gpuLayersFromGate(config.useGPU, layers),
    ...(config.threads !== undefined && { threads: config.threads }),
    ...(params.marginBytes !== undefined && { marginBytes: params.marginBytes })
  }

  return { supported: true, probe: { engine: 'audiogen-ggml', request } }
}
