import type { AudiogenFitRequest } from '@qvac/audiogen-ggml'

import type { AudioGenRuntimeConfig, MinimaxAudioGenRuntimeConfig } from '@/schemas/index'
import type { FitRequestPlan } from '@/model-fit/request/create'
import { gpuLayersFromGate } from '@/model-fit/request/gpu'

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

/**
 * MiniMax-Music3 is fitted from its LM and synthesis pair. The load config
 * carries no frame budget, so the fitter projects the default generation
 * `run()` falls back to (300 frames, 12 s).
 *
 * `device` is passed through as the load takes it. Without one, the GPU switch
 * maps to `auto` as it does on load: the fitter reads a positive layer count
 * that way. The plugin refuses MiniMax on mobile before this is reached, and
 * mobile builds carry no MiniMax fitter.
 */
function minimaxFitRequest(
  config: MinimaxAudioGenRuntimeConfig,
  artifacts: Record<string, string>,
  marginBytes: number | undefined
): FitRequestPlan {
  const lmPath = artifacts['lmModelPath']
  const synthPath = artifacts['synthModelPath']

  if (lmPath === undefined || synthPath === undefined) {
    return { supported: false, detail: 'the minimax model pair is not resolved' }
  }

  const request: AudiogenFitRequest = {
    engine: MINIMAX,
    lmPath,
    synthPath,
    ...(config.device !== undefined
      ? { device: config.device }
      : { gpuLayers: gpuLayersFromGate(config.useGPU) }),
    ...(config.threads !== undefined && { threads: config.threads }),
    ...(marginBytes !== undefined && { marginBytes })
  }

  return { supported: true, probe: { engine: 'audiogen-ggml', request } }
}

export function createAudiogenFitRequest(params: AudiogenFitRequestParams): FitRequestPlan {
  const config = (params.modelConfig ?? {}) as AudioGenRuntimeConfig
  const artifacts = params.artifacts ?? {}

  if (config.engine === MINIMAX) {
    return minimaxFitRequest(config, artifacts, params.marginBytes)
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
