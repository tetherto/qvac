import type {
  DiffusionFitRequest,
  EsrganFitRequest,
  SdConfig,
  WorldFitRequest
} from '@qvac/diffusion-cpp'

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

/**
 * The largest workload the fitter sizes. A load accepts larger declared output
 * limits, and the fitter rejects a workload above these.
 */
const FIT_MAX_DIMENSION = 65536
const FIT_MAX_VIDEO_FRAMES = 4096

/** A mobile load drops the multi-GPU keys before it runs. */
function forHost(config: SdConfig): SdConfig {
  if (isMobile()) stripMultiGpuKeys(config)
  return config
}

/** The diffusion fit request for a load: the files and config each mode loads. */
export function sdcppFitRequest(load: FitLoad): FitRequestPlan {
  if (load.isShardedModel) {
    return { unknown: 'the fitter reads one model file, and this model is split' }
  }

  const config = (load.modelConfig ?? {}) as SdcppConfig
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

  const vaeTiling = config.vaeTiling !== undefined && { vaeTiling: config.vaeTiling }

  if (config.mode === 'video') {
    // A context that declares all three output limits is sized at its largest clip.
    const boundedVideo = config.performanceMaxWidth !== undefined &&
      config.performanceMaxHeight !== undefined &&
      config.performanceMaxFrames !== undefined && {
        width: config.performanceMaxWidth,
        height: config.performanceMaxHeight,
        videoFrames: config.performanceMaxFrames
      }
    if (
      boundedVideo &&
      (boundedVideo.width > FIT_MAX_DIMENSION ||
        boundedVideo.height > FIT_MAX_DIMENSION ||
        boundedVideo.videoFrames > FIT_MAX_VIDEO_FRAMES)
    ) {
      return { unknown: 'the declared output limits exceed the largest workload the fitter sizes' }
    }
    const request: DiffusionFitRequest = {
      files: videoFilesFor(load.modelPath, artifacts),
      config: forHost(videoConfigFor(config)),
      workload: { ...vaeTiling, videoFrames: DEFAULT_VIDEO_FRAMES, ...boundedVideo }
    }
    return { request }
  }

  assertUpscalerResolved(config, artifacts)
  // The addon's fitter answers `unknown` for these too: Core ML places and sizes
  // the sidecars itself, outside the ggml planner the fitter runs.
  if (artifacts?.['coremlUnetModelPath'] || artifacts?.['coremlTaeDecoderModelPath']) {
    return { unknown: 'the fitter cannot size Core ML sidecars, which Core ML places itself' }
  }
  const request: DiffusionFitRequest = {
    files: imageFilesFor(load.modelPath, artifacts),
    config: forHost(imageConfigFor(config)),
    workload: { ...vaeTiling, ...(config.upscaler !== undefined && { upscaleRepeats: 1 }) }
  }
  return { request }
}
