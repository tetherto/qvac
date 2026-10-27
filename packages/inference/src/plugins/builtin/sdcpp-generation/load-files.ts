import type { DiffusionFiles, SdConfig, VideoStableDiffusionArgs } from '@qvac/diffusion-cpp'

import { ModelLoadFailedError } from '@/errors/index'
import { flattenUpscalerKeys } from '@/plugins/builtin/sdcpp-generation/upscaler-config'
import type { SdcppConfig } from '@/schemas/index'

type Artifacts = Record<string, string> | undefined

/**
 * In diffusion mode the ESRGAN file (when post-generation upscale is wanted)
 * must come from upscaler.model_src — the primary modelPath is the main
 * diffusion checkpoint.
 */
export function assertUpscalerResolved(config: SdcppConfig, artifacts: Artifacts): void {
  if (
    config.mode === 'diffusion' &&
    config.upscaler !== undefined &&
    !artifacts?.['esrganModelPath']
  ) {
    throw new ModelLoadFailedError(
      'modelConfig.upscaler.model_src is required when modelConfig.upscaler ' +
        'is set in diffusion mode. Provide the ESRGAN model, omit the ' +
        "upscaler block, or switch to modelConfig.mode = 'upscale' to load " +
        'a standalone upscaler.'
    )
  }
}

/** The image pipeline's files. */
export function imageFilesFor(modelPath: string, artifacts: Artifacts): DiffusionFiles {
  return {
    model: modelPath,
    ...(artifacts?.['clipLModelPath'] && { clipL: artifacts['clipLModelPath'] }),
    ...(artifacts?.['clipGModelPath'] && { clipG: artifacts['clipGModelPath'] }),
    ...(artifacts?.['t5XxlModelPath'] && { t5Xxl: artifacts['t5XxlModelPath'] }),
    ...(artifacts?.['llmModelPath'] && { llm: artifacts['llmModelPath'] }),
    ...(artifacts?.['projectionModelPath'] && { llmVision: artifacts['projectionModelPath'] }),
    ...(artifacts?.['vaeModelPath'] && { vae: artifacts['vaeModelPath'] }),
    ...(artifacts?.['uncondModelPath'] && {
      uncondModel: artifacts['uncondModelPath']
    }),
    ...(artifacts?.['esrganModelPath'] && { esrgan: artifacts['esrganModelPath'] })
  }
}

/**
 * The image pipeline's engine config. `mode` selects the model class and the
 * native config does not understand it; the upscaler block is flattened into
 * its `upscaler_*` keys.
 */
export function imageConfigFor(config: SdcppConfig): SdConfig {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { upscaler, mode, ...rest } = config
  return { ...rest, ...flattenUpscalerKeys(upscaler) } as SdConfig
}

/**
 * The video pipeline's files, selecting the companion layout the way the addon
 * self-detects it: the LTX-2 text-embedding connectors switch to the LTX-2
 * layout (Gemma via llm + video VAE + connectors, optional audio VAE —
 * `SdModel::isLtxModel_ = !embeddingsConnectorsPath.empty()`); without them, an
 * audio VAE (or an llm with no Wan T5) means MiniMax-H3 (llm + video VAE, with
 * an optional audio VAE); everything else is Wan via t5Xxl. Native code
 * verifies the model's tensors.
 */
export function videoFilesFor(
  modelPath: string,
  artifacts: Artifacts
): VideoStableDiffusionArgs['files'] {
  if (!artifacts?.['vaeModelPath']) {
    throw new ModelLoadFailedError(
      'modelConfig.vaeModelSrc is required in video mode. ' +
        'Provide the Wan, LTX-2 or MiniMax-H3 video VAE before loading the video pipeline.'
    )
  }
  const vaeModelPath = artifacts['vaeModelPath']
  const embeddingsConnectorsModelPath = artifacts['embeddingsConnectorsModelPath']

  if (embeddingsConnectorsModelPath) {
    if (!artifacts['llmModelPath']) {
      throw new ModelLoadFailedError(
        'modelConfig.llmModelSrc is required for LTX-2 video. ' +
          'Provide the Gemma text encoder model before loading the LTX-2 pipeline.'
      )
    }
    return {
      model: modelPath,
      vae: vaeModelPath,
      llm: artifacts['llmModelPath'],
      embeddingsConnectors: embeddingsConnectorsModelPath,
      ...(artifacts['audioVaeModelPath'] && {
        audioVae: artifacts['audioVaeModelPath']
      }),
      ...(artifacts['esrganModelPath'] && { esrgan: artifacts['esrganModelPath'] })
    }
  }

  if (
    artifacts['audioVaeModelPath'] ||
    (artifacts['llmModelPath'] && !artifacts['t5XxlModelPath'])
  ) {
    if (!artifacts['llmModelPath']) {
      throw new ModelLoadFailedError('MiniMax-H3 requires llmModelSrc and vaeModelSrc.')
    }
    if (
      artifacts['t5XxlModelPath'] ||
      artifacts['highNoiseDiffusionModelPath'] ||
      artifacts['clipVisionModelPath'] ||
      artifacts['clipLModelPath'] ||
      artifacts['clipGModelPath']
    ) {
      throw new ModelLoadFailedError(
        'MiniMax-H3 cannot use Wan T5, high-noise, CLIP-vision or CLIP-L/G companions.'
      )
    }
    return {
      model: modelPath,
      vae: vaeModelPath,
      llm: artifacts['llmModelPath'],
      ...(artifacts['audioVaeModelPath'] && {
        audioVae: artifacts['audioVaeModelPath']
      })
    }
  }

  if (!artifacts['t5XxlModelPath']) {
    throw new ModelLoadFailedError(
      'modelConfig.t5XxlModelSrc is required in video mode. ' +
        'Provide the Wan text encoder model before loading the video pipeline.'
    )
  }
  return {
    model: modelPath,
    vae: vaeModelPath,
    t5Xxl: artifacts['t5XxlModelPath'],
    ...(artifacts['highNoiseDiffusionModelPath'] && {
      highNoiseDiffusionModel: artifacts['highNoiseDiffusionModelPath']
    }),
    ...(artifacts['clipVisionModelPath'] && {
      clipVision: artifacts['clipVisionModelPath']
    }),
    ...(artifacts['esrganModelPath'] && { esrgan: artifacts['esrganModelPath'] })
  }
}

/** The video pipeline's engine config: the SDK's own keys stripped. */
export function videoConfigFor(config: SdcppConfig): SdConfig {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const {
    clipLModelSrc,
    clipGModelSrc,
    clipVisionModelSrc,
    t5XxlModelSrc,
    llmModelSrc,
    projectionModelSrc,
    vaeModelSrc,
    highNoiseDiffusionModelSrc,
    uncondModelSrc,
    audioVaeModelSrc,
    embeddingsConnectorsModelSrc,
    upscaler,
    mode,
    ...rest
  } = config
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return rest as SdConfig
}
