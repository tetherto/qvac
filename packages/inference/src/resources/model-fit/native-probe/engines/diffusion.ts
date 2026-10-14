import type { DiffusionFiles, SdConfig } from '@qvac/diffusion-cpp'

import type { SdcppConfig } from '@/schemas/index'
import type { FitRequestPlan } from '@/resources/model-fit/native-probe/create-fit-request'

export interface DiffusionFitRequestParams {
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
}

/**
 * Modes whose load the projection would not describe.
 *
 * `upscale` is an ESRGAN checkpoint, which has no fitter. `video` and `world`
 * assemble file sets — the audio VAE, the embeddings connectors, the TAEHV
 * preview decoder, a seed scene — that the fit request has no place for, and
 * their peak is driven by a frame count the load config does not carry.
 */
const UNFITTABLE_MODES: Record<string, string> = {
  upscale: 'a standalone upscaler load has no fitter',
  video: 'video loads are not representable',
  world: 'world loads are not representable'
}

export function createDiffusionFitRequest(params: DiffusionFitRequestParams): FitRequestPlan {
  const config = (params.modelConfig ?? {}) as SdcppConfig
  const artifacts = params.artifacts ?? {}

  const unfittable = config.mode === undefined ? undefined : UNFITTABLE_MODES[config.mode]
  if (unfittable !== undefined) return { supported: false, detail: unfittable }

  // A configured upscaler adds a second resident model the projection does not
  // account for.
  if (config.upscaler !== undefined) {
    return { supported: false, detail: 'a configured upscaler is not part of the projection' }
  }

  const files: DiffusionFiles & { clipVision?: string } = {
    model: params.modelPath,
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
        config: engineConfig as SdConfig,
        workload: {
          ...(config.vae_tiling !== undefined && { vaeTiling: config.vae_tiling })
        }
      }
    }
  }
}
