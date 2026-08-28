import {
  AudioGen,
  ENGINE_ACESTEP,
  ENGINE_MINIMAX,
  type AudioGenEngine,
  type AudioGenFiles
} from '@qvac/audiogen-ggml'
import {
  ADDON_AUDIOGEN,
  ModelType,
  audioGenConfigSchema,
  audioGenStreamRequestSchema,
  audioGenStreamResponseSchema,
  defineHandler,
  definePlugin,
  type AudioGenRuntimeConfig,
  type CreateModelParams,
  type PluginModelResult
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger } from '@/logging/index'
import { resolveAudioGenConfig } from '@/plugins/builtin/audiogen-ggml/config'
import { audioGenStream } from '@/plugins/builtin/audiogen-ggml/ops/audio-gen-stream'
import { ModelLoadFailedError } from '@/errors/index'

export const audioGenPlugin = definePlugin({
  modelType: ModelType.audiogenGgml,
  displayName: 'Audio Generation (GGML / ACE-Step and MiniMax)',
  addonPackage: ADDON_AUDIOGEN,
  loadConfigSchema: audioGenConfigSchema,
  // AudioGen's primary `modelSrc` is intentionally empty: all required
  // weights are config-owned artifacts resolved from the four model sources.
  skipPrimaryModelPathValidation: true,

  resolveConfig: resolveAudioGenConfig,

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as AudioGenRuntimeConfig
    const engine = config.engine ?? ENGINE_ACESTEP
    const files = getAudioGenFiles(engine, params.artifacts)

    const logger = createStreamLogger(params.modelId, ModelType.audiogenGgml)
    const addonConfig = getAudioGenAddonConfig(config)
    const model = new AudioGen({
      engine,
      files,
      config: addonConfig,
      logger
    })
    registerAddonLogger(params.modelId, ModelType.audiogenGgml, logger)

    return { model }
  },

  handlers: {
    audioGenStream: defineHandler({
      requestSchema: audioGenStreamRequestSchema,
      responseSchema: audioGenStreamResponseSchema,
      streaming: true,
      cancel: { scope: 'model', hard: true },
      handler: audioGenStream
    })
  }
})

function getAudioGenFiles(
  engine: AudioGenEngine,
  artifacts: CreateModelParams['artifacts']
): AudioGenFiles {
  const lmModel = artifacts?.['lmModelPath']
  if (engine === ENGINE_MINIMAX) {
    const synthModel = artifacts?.['synthModelPath']
    if (!lmModel || !synthModel) {
      throw new ModelLoadFailedError(
        'MiniMax AudioGen requires resolved LM and synthesis artifacts'
      )
    }
    return { lmModel, synthModel }
  }

  const textEncModel = artifacts?.['textEncModelPath']
  const ditModel = artifacts?.['ditModelPath']
  const vaeModel = artifacts?.['vaeModelPath']
  if (!textEncModel || !lmModel || !ditModel || !vaeModel) {
    throw new ModelLoadFailedError(
      'ACE-Step AudioGen requires resolved text encoder, LM, DiT, and VAE artifacts'
    )
  }
  return { textEncModel, lmModel, ditModel, vaeModel }
}

function getAudioGenAddonConfig(config: AudioGenRuntimeConfig) {
  const commonConfig = {
    ...(config.useGPU !== undefined && { useGPU: config.useGPU }),
    ...(config.threads !== undefined && { threads: config.threads }),
    ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir })
  }
  if (config.engine === ENGINE_MINIMAX) {
    return {
      ...commonConfig,
      ...(config.inferenceSteps !== undefined && { inferenceSteps: config.inferenceSteps }),
      ...(config.cfgScale !== undefined && { cfgScale: config.cfgScale })
    }
  }
  return {
    ...commonConfig,
    ...(config.inferenceSteps !== undefined && { inferenceSteps: config.inferenceSteps }),
    ...(config.shift !== undefined && { shift: config.shift }),
    ...(config.nGpuLayers !== undefined && { nGpuLayers: config.nGpuLayers })
  }
}
