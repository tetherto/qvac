import type { DiffusionFitRequest, EsrganFitRequest, WorldFitRequest } from '@qvac/diffusion-cpp'

import { ModelLoadFailedError } from '@/errors/index'
import {
  assertUpscalerResolved,
  imageConfigFor,
  imageFilesFor,
  videoConfigFor,
  videoFilesFor
} from '@/plugins/builtin/sdcpp-generation/load-files'
import { toEsrganAddonConfig } from '@/plugins/builtin/sdcpp-generation/upscaler-config'
import { splitWorldConfig } from '@/plugins/builtin/sdcpp-generation/world-config'
import { isMobile } from '@/runtime/state'
import type { SdcppConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'

/**
 * Frames to project a video load at. The fitter reads one frame when nothing
 * is passed, which projects image generation; `run` generates 33. The frame
 * count is a generation parameter, and this assessment sees load config alone.
 */
const DEFAULT_VIDEO_FRAMES = 33

/** The diffusion fit request for a load: the files and config each mode loads. */
export function sdcppFitRequest(load: FitLoad): FitRequestPlan {
  if (load.isShardedModel) {
    return { unknown: 'the fitter reads one model file, and this model is split' }
  }

  const config = { ...((load.modelConfig ?? {}) as SdcppConfig) }
  // A mobile load drops the multi-GPU keys before it runs.
  if (isMobile()) stripMultiGpuKeys(config)
  const artifacts = load.artifacts

  if (config.mode === 'upscale') {
    const request: EsrganFitRequest = {
      mode: 'upscale',
      files: { esrgan: load.modelPath },
      config: toEsrganAddonConfig(config),
      workload: { upscaleRepeats: 1 }
    }
    return { request }
  }

  if (config.mode === 'world') {
    const taehv = artifacts?.['taehvModelPath']
    if (!taehv) {
      throw new ModelLoadFailedError(
        'modelConfig.taehvModelSrc is required in world mode. ' +
          'Provide the taew2_2 pixel decoder before loading the walk session.'
      )
    }
    // The fitter sizes the session from the scene's header, and a session
    // without a seed scene has none until worldCreateScene builds it.
    const scene = artifacts['seedScenePath']
    if (!scene) return { unknown: 'a world session without a seed scene has no scene to size' }
    const { fitSteps, session } = splitWorldConfig(config.world)
    const request: WorldFitRequest = {
      mode: 'world',
      files: { model: load.modelPath, taehv, scene },
      config: session,
      workload: { walkSteps: fitSteps }
    }
    return { request }
  }

  const vaeTiling = config.vae_tiling !== undefined && { vaeTiling: config.vae_tiling }

  if (config.mode === 'video') {
    const request: DiffusionFitRequest = {
      files: videoFilesFor(load.modelPath, artifacts),
      config: videoConfigFor(config),
      workload: { ...vaeTiling, videoFrames: DEFAULT_VIDEO_FRAMES }
    }
    return { request }
  }

  assertUpscalerResolved(config, artifacts)
  const request: DiffusionFitRequest = {
    files: imageFilesFor(load.modelPath, artifacts),
    config: imageConfigFor(config),
    workload: { ...vaeTiling, ...(config.upscaler !== undefined && { upscaleRepeats: 1 }) }
  }
  return { request }
}
