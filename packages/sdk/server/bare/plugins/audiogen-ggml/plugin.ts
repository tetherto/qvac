import { AudioGen } from '@qvac/audiogen-ggml'
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
} from '@/schemas'
import { createStreamLogger, registerAddonLogger } from '@/logging'
import { resolveAudioGenConfig } from '@/server/bare/plugins/audiogen-ggml/config'
import { audioGenStream } from '@/server/bare/plugins/audiogen-ggml/ops/audio-gen-stream'
import { ModelLoadFailedError } from '@/utils/errors-server'

export const audioGenPlugin = definePlugin({
  modelType: ModelType.audiogenGgml,
  displayName: 'Audio Generation (GGML / ACE-Step)',
  addonPackage: ADDON_AUDIOGEN,
  loadConfigSchema: audioGenConfigSchema,
  // AudioGen's primary `modelSrc` is intentionally empty: all required
  // weights are config-owned artifacts resolved from the four model sources.
  skipPrimaryModelPathValidation: true,

  resolveConfig: resolveAudioGenConfig,

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as AudioGenRuntimeConfig
    const textEncModel = params.artifacts?.['textEncModelPath']
    const lmModel = params.artifacts?.['lmModelPath']
    const ditModel = params.artifacts?.['ditModelPath']
    const vaeModel = params.artifacts?.['vaeModelPath']

    if (!textEncModel || !lmModel || !ditModel || !vaeModel) {
      throw new ModelLoadFailedError(
        'AudioGen requires resolved text encoder, LM, DiT, and VAE model artifacts'
      )
    }

    const logger = createStreamLogger(params.modelId, ModelType.audiogenGgml)
    const addonConfig = {
      ...(config.useGPU !== undefined && { useGPU: config.useGPU }),
      ...(config.inferenceSteps !== undefined && {
        inferenceSteps: config.inferenceSteps
      }),
      ...(config.shift !== undefined && { shift: config.shift }),
      ...(config.nGpuLayers !== undefined && { nGpuLayers: config.nGpuLayers }),
      ...(config.threads !== undefined && { threads: config.threads }),
      ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir })
    }
    const model = new AudioGen({
      files: {
        textEncModel,
        lmModel,
        ditModel,
        vaeModel
      },
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
