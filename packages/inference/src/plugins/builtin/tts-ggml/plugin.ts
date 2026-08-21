import ttsAddonLogging from '@qvac/tts-ggml/addonLogging'
import TTSGgml from '@qvac/tts-ggml'
import {
  definePlugin,
  defineHandler,
  defineDuplexHandler,
  ttsRequestSchema,
  ttsResponseSchema,
  textToSpeechStreamRequestSchema,
  textToSpeechStreamResponseSchema,
  ModelType,
  ttsConfigSchema,
  ADDON_TTS,
  LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type ResolveResult,
  type TtsAudio8LoadConfig,
  type TtsChatterboxLoadConfig,
  type TtsCosyvoice3LoadConfig,
  type TtsParlerLoadConfig,
  type TtsSupertonicLoadConfig,
  type TtsRuntimeConfig,
  type TtsAudio8RuntimeConfig,
  type TtsChatterboxRuntimeConfig,
  type TtsCosyvoice3RuntimeConfig,
  type TtsParlerRuntimeConfig,
  type TtsSupertonicRuntimeConfig
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger } from '@/logging/index'
import { TtsArtifactsRequiredError, LegacyTtsModelDeprecatedError } from '@/errors/index'
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { textToSpeechStream } from '@/plugins/builtin/tts-ggml/ops/text-to-speech-stream'
import { attachModelExecutionMs } from '@/profiling/model-execution'

function rejectLegacyOnnxFields(cfg: object) {
  const record = cfg as Record<string, unknown>
  const legacyFields = LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS.filter(
    (name) => record[name] !== undefined
  )
  if (legacyFields.length > 0) {
    throw new LegacyTtsModelDeprecatedError(legacyFields)
  }
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return index === 0 ? '/' : '.'
  return path.slice(0, index)
}

// Resolve the optional LavaSR enhancer/denoiser GGUFs shared by both engines.
async function resolveLavasrArtifacts(
  lavasrEnhancerModelSrc: TtsChatterboxLoadConfig['lavasrEnhancerModelSrc'],
  lavasrDenoiserModelSrc: TtsChatterboxLoadConfig['lavasrDenoiserModelSrc'],
  ctx: ResolveContext
) {
  const resolve = ctx.resolveModelPath
  const [lavasrEnhancerPath, lavasrDenoiserPath] = await Promise.all([
    lavasrEnhancerModelSrc ? resolve(lavasrEnhancerModelSrc) : Promise.resolve(undefined),
    lavasrDenoiserModelSrc ? resolve(lavasrDenoiserModelSrc) : Promise.resolve(undefined)
  ])

  return {
    ...(lavasrEnhancerPath ? { lavasrEnhancerPath } : {}),
    ...(lavasrDenoiserPath ? { lavasrDenoiserPath } : {})
  }
}

async function resolveChatterboxConfig(
  config: TtsChatterboxLoadConfig,
  ctx: ResolveContext
): Promise<ResolveResult<TtsRuntimeConfig>> {
  rejectLegacyOnnxFields(config)

  const {
    s3genModelSrc,
    referenceAudioSrc,
    mecabDictSrc,
    cangjieTsvSrc,
    lavasrEnhancerModelSrc,
    lavasrDenoiserModelSrc,
    ...runtime
  } = config
  if (!s3genModelSrc) {
    throw new TtsArtifactsRequiredError()
  }

  const resolve = ctx.resolveModelPath
  const [s3genPath, referenceAudioPath, mecabDictFilePath, cangjieTsvPath, lavasrArtifacts] =
    await Promise.all([
      resolve(s3genModelSrc),
      referenceAudioSrc ? resolve(referenceAudioSrc) : Promise.resolve(undefined),
      mecabDictSrc ? resolve(mecabDictSrc) : Promise.resolve(undefined),
      cangjieTsvSrc ? resolve(cangjieTsvSrc) : Promise.resolve(undefined),
      resolveLavasrArtifacts(lavasrEnhancerModelSrc, lavasrDenoiserModelSrc, ctx)
    ])

  return {
    config: runtime,
    artifacts: {
      s3genPath,
      ...(referenceAudioPath ? { referenceAudioPath } : {}),
      ...(mecabDictFilePath ? { mecabDictPath: dirname(mecabDictFilePath) } : {}),
      ...(cangjieTsvPath ? { cangjieTsvPath } : {}),
      ...lavasrArtifacts
    }
  }
}

async function resolveSupertonicConfig(
  config: TtsSupertonicLoadConfig,
  ctx: ResolveContext
): Promise<ResolveResult<TtsRuntimeConfig>> {
  rejectLegacyOnnxFields(config)

  const { lavasrEnhancerModelSrc, lavasrDenoiserModelSrc, ...runtime } = config
  const lavasrArtifacts = await resolveLavasrArtifacts(
    lavasrEnhancerModelSrc,
    lavasrDenoiserModelSrc,
    ctx
  )

  return { config: runtime, artifacts: lavasrArtifacts }
}

function resolveParlerConfig(config: TtsParlerLoadConfig): ResolveResult<TtsRuntimeConfig> {
  return { config, artifacts: {} }
}

// CosyVoice3's multi-file layout (flow/HiFT GGUFs, voice.gguf, vocab.json,
// merges.txt) rides the primary model's registry companion set, so only the
// optional LavaSR post-processing sources need resolution here.
async function resolveCosyvoice3Config(
  config: TtsCosyvoice3LoadConfig,
  ctx: ResolveContext
): Promise<ResolveResult<TtsRuntimeConfig>> {
  const { lavasrEnhancerModelSrc, lavasrDenoiserModelSrc, ...runtime } = config
  const lavasrArtifacts = await resolveLavasrArtifacts(
    lavasrEnhancerModelSrc,
    lavasrDenoiserModelSrc,
    ctx
  )

  return { config: runtime, artifacts: lavasrArtifacts }
}

async function resolveAudio8Config(
  config: TtsAudio8LoadConfig,
  ctx: ResolveContext
): Promise<ResolveResult<TtsRuntimeConfig>> {
  const { audio8CodecDecoderModelSrc, audio8CodecEncoderModelSrc, referenceAudioSrc, ...runtime } =
    config
  if (!audio8CodecDecoderModelSrc) {
    throw new TtsArtifactsRequiredError()
  }

  const resolve = ctx.resolveModelPath
  const [audio8CodecDecoderPath, audio8CodecEncoderPath, referenceAudioPath] = await Promise.all([
    resolve(audio8CodecDecoderModelSrc),
    audio8CodecEncoderModelSrc ? resolve(audio8CodecEncoderModelSrc) : Promise.resolve(undefined),
    referenceAudioSrc ? resolve(referenceAudioSrc) : Promise.resolve(undefined)
  ])

  return {
    config: runtime,
    artifacts: {
      audio8CodecDecoderPath,
      ...(audio8CodecEncoderPath ? { audio8CodecEncoderPath } : {}),
      ...(referenceAudioPath ? { referenceAudioPath } : {})
    }
  }
}

// Build the optional LavaSR `files` entries from resolved artifacts. Supplying
// a path is what enables the stage in @qvac/tts-ggml — there is no on/off flag.
function lavasrFiles(artifacts: Record<string, string | undefined>) {
  const lavasrEnhancer = artifacts['lavasrEnhancerPath']
  const lavasrDenoiser = artifacts['lavasrDenoiserPath']
  return {
    ...(lavasrEnhancer ? { lavasrEnhancer } : {}),
    ...(lavasrDenoiser ? { lavasrDenoiser } : {})
  }
}

function createChatterboxModel(
  modelId: string,
  config: TtsChatterboxRuntimeConfig,
  params: CreateModelParams,
  artifacts: Record<string, string | undefined>
): PluginModelResult {
  const t3Model = params.modelPath
  const s3genModel = artifacts['s3genPath']
  const referenceAudioPath = artifacts['referenceAudioPath']
  const mecabDictPath = artifacts['mecabDictPath']
  const cangjieTsvPath = artifacts['cangjieTsvPath']

  if (!t3Model || !s3genModel) {
    throw new TtsArtifactsRequiredError()
  }

  const logger = createStreamLogger(modelId, ModelType.ttsGgml)

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_CHATTERBOX,
    files: {
      t3Model,
      s3genModel,
      ...(mecabDictPath ? { mecabDictPath } : {}),
      ...(cangjieTsvPath ? { cangjieTsvPath } : {}),
      ...lavasrFiles(artifacts)
    },
    ...(referenceAudioPath ? { referenceAudio: referenceAudioPath } : {}),
    ...(config.streamChunkTokens !== undefined
      ? { streamChunkTokens: config.streamChunkTokens }
      : {}),
    ...(config.streamFirstChunkTokens !== undefined
      ? { streamFirstChunkTokens: config.streamFirstChunkTokens }
      : {}),
    ...(config.cfmSteps !== undefined ? { cfmSteps: config.cfmSteps } : {}),
    ...(config.cfgRate !== undefined ? { cfgRate: config.cfgRate } : {}),
    ...(config.threads !== undefined ? { threads: config.threads } : {}),
    ...(config.nGpuLayers !== undefined ? { nGpuLayers: config.nGpuLayers } : {}),
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    config: {
      language: config.language ?? 'en',
      ...(config.useGPU !== undefined ? { useGPU: config.useGPU } : {})
    },
    logger,
    opts: { stats: true },
    exclusiveRun: true
  })

  registerAddonLogger(modelId, ModelType.ttsGgml, logger)
  return { model }
}

function createSupertonicModel(
  modelId: string,
  config: TtsSupertonicRuntimeConfig,
  params: CreateModelParams,
  artifacts: Record<string, string | undefined>
): PluginModelResult {
  const supertonicModel = params.modelPath
  if (!supertonicModel) {
    throw new TtsArtifactsRequiredError()
  }

  const logger = createStreamLogger(modelId, ModelType.ttsGgml)

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel, ...lavasrFiles(artifacts) },
    voice: config.voice ?? 'F1',
    ...(config.ttsSpeed !== undefined ? { speed: config.ttsSpeed } : {}),
    ...(config.ttsNumInferenceSteps !== undefined
      ? { numInferenceSteps: config.ttsNumInferenceSteps }
      : {}),
    config: {
      language: config.language ?? 'en',
      useGPU: config.useGPU ?? false,
      ...(config.outputSampleRate !== undefined
        ? { outputSampleRate: config.outputSampleRate }
        : {}),
      ...(config.vulkanCacheDir !== undefined ? { vulkanCacheDir: config.vulkanCacheDir } : {})
    },
    logger,
    opts: { stats: true },
    exclusiveRun: true
  })

  registerAddonLogger(modelId, ModelType.ttsGgml, logger)
  return { model }
}

function createParlerModel(
  modelId: string,
  config: TtsParlerRuntimeConfig,
  params: CreateModelParams
): PluginModelResult {
  const parlerModel = params.modelPath
  if (!parlerModel) {
    throw new TtsArtifactsRequiredError()
  }

  const logger = createStreamLogger(modelId, ModelType.ttsGgml)

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_PARLER,
    files: { parlerModel },
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.voiceDescription !== undefined ? { voiceDescription: config.voiceDescription } : {}),
    ...(config.voice !== undefined ? { voice: config.voice } : {}),
    ...(config.emotion !== undefined ? { emotion: config.emotion } : {}),
    ...(config.pitch !== undefined ? { pitch: config.pitch } : {}),
    ...(config.pace !== undefined ? { pace: config.pace } : {}),
    ...(config.expressivity !== undefined ? { expressivity: config.expressivity } : {}),
    ...(config.noise !== undefined ? { noise: config.noise } : {}),
    ...(config.reverb !== undefined ? { reverb: config.reverb } : {}),
    ...(config.quality !== undefined ? { quality: config.quality } : {}),
    ...(config.streamChunkTokens !== undefined
      ? { streamChunkTokens: config.streamChunkTokens }
      : {}),
    ...(config.streamFirstChunkTokens !== undefined
      ? { streamFirstChunkTokens: config.streamFirstChunkTokens }
      : {}),
    ...(config.threads !== undefined ? { threads: config.threads } : {}),
    ...(config.nGpuLayers !== undefined ? { nGpuLayers: config.nGpuLayers } : {}),
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.topK !== undefined ? { topK: config.topK } : {}),
    ...(config.topP !== undefined ? { topP: config.topP } : {}),
    ...(config.maxFrames !== undefined ? { maxFrames: config.maxFrames } : {}),
    ...(config.minNewTokens !== undefined ? { minNewTokens: config.minNewTokens } : {}),
    ...(config.normalizeNumbers !== undefined ? { normalizeNumbers: config.normalizeNumbers } : {}),
    config: {
      ...(config.useGPU !== undefined ? { useGPU: config.useGPU } : {}),
      ...(config.outputSampleRate !== undefined
        ? { outputSampleRate: config.outputSampleRate }
        : {})
    },
    logger,
    opts: { stats: true },
    exclusiveRun: true
  })

  registerAddonLogger(modelId, ModelType.ttsGgml, logger)
  return { model }
}

// Rebuild the structured instruct without explicit-undefined keys so it
// satisfies the addon's exactOptionalPropertyTypes constructor typing.
function toAddonInstruct(instruct: NonNullable<TtsCosyvoice3RuntimeConfig['instruct']>) {
  if (typeof instruct === 'string') return instruct
  return {
    ...(instruct.dialect !== undefined ? { dialect: instruct.dialect } : {}),
    ...(instruct.volume !== undefined ? { volume: instruct.volume } : {}),
    ...(instruct.style !== undefined ? { style: instruct.style } : {})
  }
}

function createCosyvoice3Model(
  modelId: string,
  config: TtsCosyvoice3RuntimeConfig,
  params: CreateModelParams,
  artifacts: Record<string, string | undefined>
): PluginModelResult {
  const cosyvoiceLlmModel = params.modelPath
  if (!cosyvoiceLlmModel) {
    throw new TtsArtifactsRequiredError()
  }

  const logger = createStreamLogger(modelId, ModelType.ttsGgml)

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_COSYVOICE3,
    // The LLM GGUF's registry companion set co-locates the flow/HiFT GGUFs,
    // voice.gguf, vocab.json and merges.txt next to it, so its containing
    // directory is the addon's model dir.
    files: {
      cosyvoiceModelDir: dirname(cosyvoiceLlmModel),
      cosyvoiceLlmModel,
      ...lavasrFiles(artifacts)
    },
    ...(config.emotion !== undefined ? { emotion: config.emotion } : {}),
    ...(config.pace !== undefined ? { pace: config.pace } : {}),
    ...(config.instruct !== undefined ? { instruct: toAddonInstruct(config.instruct) } : {}),
    ...(config.streamChunkTokens !== undefined
      ? { streamChunkTokens: config.streamChunkTokens }
      : {}),
    ...(config.streamFirstChunkTokens !== undefined
      ? { streamFirstChunkTokens: config.streamFirstChunkTokens }
      : {}),
    ...(config.threads !== undefined ? { threads: config.threads } : {}),
    ...(config.nGpuLayers !== undefined ? { nGpuLayers: config.nGpuLayers } : {}),
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    config: {
      ...(config.useGPU !== undefined ? { useGPU: config.useGPU } : {}),
      ...(config.outputSampleRate !== undefined
        ? { outputSampleRate: config.outputSampleRate }
        : {})
    },
    logger,
    opts: { stats: true },
    exclusiveRun: true
  })

  registerAddonLogger(modelId, ModelType.ttsGgml, logger)
  return { model }
}

function createAudio8Model(
  modelId: string,
  config: TtsAudio8RuntimeConfig,
  params: CreateModelParams,
  artifacts: Record<string, string | undefined>
): PluginModelResult {
  const audio8Lm = params.modelPath
  const audio8CodecDecoder = artifacts['audio8CodecDecoderPath']
  const audio8CodecEncoder = artifacts['audio8CodecEncoderPath']
  const referenceAudioPath = artifacts['referenceAudioPath']

  if (!audio8Lm || !audio8CodecDecoder) {
    throw new TtsArtifactsRequiredError()
  }

  const logger = createStreamLogger(modelId, ModelType.ttsGgml)

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_AUDIO8,
    files: {
      audio8Lm,
      audio8CodecDecoder,
      ...(audio8CodecEncoder ? { audio8CodecEncoder } : {})
    },
    ...(referenceAudioPath ? { referenceAudio: referenceAudioPath } : {}),
    ...(config.referenceText !== undefined ? { referenceText: config.referenceText } : {}),
    ...(config.greedy !== undefined ? { greedy: config.greedy } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.topK !== undefined ? { topK: config.topK } : {}),
    ...(config.topP !== undefined ? { topP: config.topP } : {}),
    ...(config.maxFrames !== undefined ? { maxFrames: config.maxFrames } : {}),
    ...(config.threads !== undefined ? { threads: config.threads } : {}),
    ...(config.nGpuLayers !== undefined ? { nGpuLayers: config.nGpuLayers } : {}),
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    config: {
      ...(config.useGPU !== undefined ? { useGPU: config.useGPU } : {}),
      ...(config.outputSampleRate !== undefined
        ? { outputSampleRate: config.outputSampleRate }
        : {})
    },
    logger,
    opts: { stats: true },
    exclusiveRun: true
  })

  registerAddonLogger(modelId, ModelType.ttsGgml, logger)
  return { model }
}

export const ttsPlugin = definePlugin({
  modelType: ModelType.ttsGgml,
  displayName: 'TTS (GGML)',
  addonPackage: ADDON_TTS,
  loadConfigSchema: ttsConfigSchema,

  async resolveConfig(cfg: Record<string, unknown>, ctx: ResolveContext) {
    const { ttsEngine } = cfg as { ttsEngine?: string }

    // Same default as the former onnx-tts plugin: omitting `ttsEngine` → Chatterbox.
    if (ttsEngine === 'parler') {
      return resolveParlerConfig(cfg as TtsParlerLoadConfig)
    }
    if (ttsEngine === 'cosyvoice3') {
      return resolveCosyvoice3Config(cfg as TtsCosyvoice3LoadConfig, ctx)
    }
    if (ttsEngine === 'audio8') {
      return resolveAudio8Config(cfg as TtsAudio8LoadConfig, ctx)
    }
    if (ttsEngine === 'supertonic') {
      return resolveSupertonicConfig(cfg as TtsSupertonicLoadConfig, ctx)
    }
    return resolveChatterboxConfig(cfg as TtsChatterboxLoadConfig, ctx)
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as TtsRuntimeConfig
    const artifacts = params.artifacts ?? {}

    if (config.ttsEngine === 'parler') {
      return createParlerModel(params.modelId, config, params)
    }
    if (config.ttsEngine === 'cosyvoice3') {
      return createCosyvoice3Model(params.modelId, config, params, artifacts)
    }
    if (config.ttsEngine === 'audio8') {
      return createAudio8Model(params.modelId, config, params, artifacts)
    }
    if (config.ttsEngine === 'supertonic') {
      return createSupertonicModel(params.modelId, config, params, artifacts)
    }

    return createChatterboxModel(params.modelId, config, params, artifacts)
  },

  handlers: {
    textToSpeech: defineHandler({
      requestSchema: ttsRequestSchema,
      responseSchema: ttsResponseSchema,
      streaming: true,
      cancel: { scope: 'model', hard: true },

      handler: async function* (request) {
        const stream = textToSpeech(request)
        try {
          let result = await stream.next()

          while (!result.done) {
            yield {
              type: 'textToSpeech' as const,
              buffer: result.value.buffer,
              done: false,
              ...(result.value.chunkIndex !== undefined
                ? { chunkIndex: result.value.chunkIndex }
                : {}),
              ...(typeof result.value.sentenceChunk === 'string' &&
              result.value.sentenceChunk.length > 0
                ? { sentenceChunk: result.value.sentenceChunk }
                : {})
            }
            result = await stream.next()
          }

          const { modelExecutionMs, stats } = result.value
          yield attachModelExecutionMs(
            {
              type: 'textToSpeech' as const,
              buffer: [],
              done: true,
              ...(stats && { stats })
            },
            modelExecutionMs
          )
        } finally {
          await stream.return?.(undefined as never)
        }
      }
    }),

    textToSpeechStream: defineDuplexHandler({
      requestSchema: textToSpeechStreamRequestSchema,
      responseSchema: textToSpeechStreamResponseSchema,
      streaming: true,
      duplex: true,
      cancel: { scope: 'model', hard: true },

      handler: async function* (request, inputStream) {
        const stream = textToSpeechStream(request, inputStream)
        try {
          let result = await stream.next()

          while (!result.done) {
            yield {
              type: 'textToSpeechStream' as const,
              buffer: result.value.buffer,
              done: false,
              ...(result.value.chunkIndex !== undefined
                ? { chunkIndex: result.value.chunkIndex }
                : {}),
              ...(typeof result.value.sentenceChunk === 'string' &&
              result.value.sentenceChunk.length > 0
                ? { sentenceChunk: result.value.sentenceChunk }
                : {})
            }
            result = await stream.next()
          }

          const { modelExecutionMs, stats } = result.value
          yield attachModelExecutionMs(
            {
              type: 'textToSpeechStream' as const,
              buffer: [],
              done: true,
              ...(stats && { stats })
            },
            modelExecutionMs
          )
        } finally {
          await stream.return?.(undefined as never)
        }
      }
    })
  },

  logging: {
    module: ttsAddonLogging,
    namespace: ModelType.ttsGgml
  }
})
