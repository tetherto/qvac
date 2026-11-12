import type { AudiogenFitRequest } from '@qvac/audiogen-ggml'

import { gpuLayersFromGate } from '@/model-fit/gpu'
import type { AudioGenRuntimeConfig, MinimaxAudioGenRuntimeConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

/**
 * `@qvac/audiogen-ggml` is an optional peer dependency, so its value exports
 * are unavailable to a host that ships without it. The engine discriminator is
 * matched by its literal rather than imported.
 */
const MINIMAX = 'minimax'

/**
 * MiniMax-Music3 is fitted from its LM and synthesis pair. The load config
 * carries no frame budget, so the fitter projects the default generation
 * `run()` falls back to (300 frames, 12 s).
 *
 * `device` is passed through as the load takes it. Without one, the GPU switch
 * maps to `auto` as it does on load: the fitter reads a positive layer count
 * that way. A Core ML profile or conditioner is passed through too: the fitter
 * cannot size either route and answers `unknown` for it. The plugin refuses
 * MiniMax on mobile before this is reached.
 */
function minimaxFitRequest(
  config: MinimaxAudioGenRuntimeConfig,
  artifacts: Record<string, string>
): FitRequestPlan {
  const lmPath = artifacts['lmModelPath']
  const synthPath = artifacts['synthModelPath']
  if (lmPath === undefined || synthPath === undefined) {
    return { unknown: 'the minimax model pair is not resolved' }
  }

  const request: AudiogenFitRequest = {
    engine: MINIMAX,
    lmPath,
    synthPath,
    ...(config.device !== undefined
      ? { device: config.device }
      : { gpuLayers: gpuLayersFromGate(config.useGPU) }),
    ...(config.coremlConditionerPath !== undefined && {
      coremlConditionerPath: config.coremlConditionerPath
    }),
    ...(config.coremlProfileDir !== undefined && { coremlProfileDir: config.coremlProfileDir }),
    ...(config.coremlComputeUnits !== undefined && {
      coremlComputeUnits: config.coremlComputeUnits
    }),
    ...(config.threads !== undefined && { threads: config.threads })
  }
  return { request }
}

/** The audiogen fit request for a load, from its resolved stage checkpoints. */
export function audiogenFitRequest(load: FitLoad): FitRequestPlan {
  const config = (load.modelConfig ?? {}) as AudioGenRuntimeConfig
  const artifacts = load.artifacts ?? {}

  if (config.engine === MINIMAX) return minimaxFitRequest(config, artifacts)

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
    return { unknown: 'the ace-step stage checkpoints are not all resolved' }
  }

  const layers = 'nGpuLayers' in config ? config.nGpuLayers : undefined
  // A named backend moves a stage to its own device, so the fitter is given
  // the placement the load will ask for and sizes each device it names.
  const request: AudiogenFitRequest = {
    textEncoderPath,
    lmPath,
    ditPath,
    vaePath,
    gpuLayers: gpuLayersFromGate(config.useGPU, layers),
    ...(config.backend !== undefined && { backend: config.backend }),
    ...(config.lmBackend !== undefined && { lmBackend: config.lmBackend }),
    ...(config.threads !== undefined && { threads: config.threads })
  }
  return { request }
}
