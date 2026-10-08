import type { DiffusionFiles, SdConfig } from '@qvac/diffusion-cpp'
import type { WorldConfig } from '@qvac/diffusion-cpp/world'

import type { SdcppConfig } from '@/schemas/index'
import type { FitRequestPlan } from '@/resources/model-fit/native-probe/create-fit-request'
import {
  flattenUpscalerKeys,
  toEsrganAddonConfig
} from '@/plugins/builtin/sdcpp-generation/upscaler-config'

export interface DiffusionFitRequestParams {
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
}

/**
 * Frames to project a video load at. The fitter reads one frame when nothing
 * is passed, which projects image generation; `run` generates 33. The frame
 * count is a generation parameter, and this assessment sees load config alone.
 */
const DEFAULT_VIDEO_FRAMES = 33

export function createDiffusionFitRequest(params: DiffusionFitRequestParams): FitRequestPlan {
  const config = (params.modelConfig ?? {}) as SdcppConfig
  const artifacts = params.artifacts ?? {}

  if (config.mode === 'world') {
    const taehv = artifacts['taehvModelPath']
    const scene = artifacts['seedScenePath']
    if (taehv === undefined || scene === undefined) {
      return { supported: false, detail: 'ABot fit requires a resolved decoder and scene pack' }
    }
    const { fitSteps = 100, ...worldConfig } = config.world ?? {}
    return {
      supported: true,
      probe: {
        engine: 'diffusion-cpp',
        request: {
          mode: 'world',
          files: { model: params.modelPath, taehv, scene },
          config: worldConfig as WorldConfig,
          workload: { walkSteps: fitSteps }
        }
      }
    }
  }

  if (config.mode === 'upscale') {
    return {
      supported: true,
      probe: {
        engine: 'diffusion-cpp',
        request: {
          mode: 'upscale',
          files: { esrgan: params.modelPath },
          config: toEsrganAddonConfig(config),
          workload: { upscaleRepeats: 1 }
        }
      }
    }
  }

  const upscaler = config.mode === 'video' ? undefined : config.upscaler
  if (upscaler !== undefined && artifacts['esrganModelPath'] === undefined) {
    return { supported: false, detail: 'the configured ESRGAN checkpoint is not resolved' }
  }

  const files: DiffusionFiles & { clipVision?: string } = {
    model: params.modelPath,
    ...(upscaler !== undefined && { esrgan: artifacts['esrganModelPath']! }),
    ...(artifacts['clipLModelPath'] !== undefined && { clipL: artifacts['clipLModelPath'] }),
    ...(artifacts['clipGModelPath'] !== undefined && { clipG: artifacts['clipGModelPath'] }),
    ...(artifacts['t5XxlModelPath'] !== undefined && { t5Xxl: artifacts['t5XxlModelPath'] }),
    ...(artifacts['llmModelPath'] !== undefined && { llm: artifacts['llmModelPath'] }),
    ...(artifacts['vaeModelPath'] !== undefined && { vae: artifacts['vaeModelPath'] }),
    ...(artifacts['uncondModelPath'] !== undefined && {
      uncondModel: artifacts['uncondModelPath']
    }),
    ...(artifacts['clipVisionModelPath'] !== undefined && {
      clipVision: artifacts['clipVisionModelPath']
    }),
    ...(artifacts['audioVaeModelPath'] !== undefined && {
      audioVae: artifacts['audioVaeModelPath']
    }),
    ...(artifacts['embeddingsConnectorsModelPath'] !== undefined && {
      embeddingsConnectors: artifacts['embeddingsConnectorsModelPath']
    })
  }

  // `mode` and `upscaler` are this SDK's own keys; the engine config has no
  // field for either.
  const { mode: _mode, upscaler: _upscaler, ...engineConfig } = config

  return {
    supported: true,
    probe: {
      engine: 'diffusion-cpp',
      request: {
        files,
        config: { ...engineConfig, ...flattenUpscalerKeys(upscaler) } as SdConfig,
        workload: {
          ...(config.vae_tiling !== undefined && { vaeTiling: config.vae_tiling }),
          ...(config.mode === 'video' && { videoFrames: DEFAULT_VIDEO_FRAMES }),
          ...(upscaler !== undefined && { upscaleRepeats: 1 })
        }
      }
    }
  }
}
