import asrAddonLogging from '@qvac/asr-ggml/addonLogging'
import ASRGgml from '@qvac/asr-ggml'
import {
  definePlugin,
  defineHandler,
  defineDuplexHandler,
  transcribeRequestSchema,
  transcribeResponseSchema,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  ModelType,
  whisperConfigSchema,
  ADDON_ASR,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type TranscribeSegment,
  type WhisperConfig
} from '@/schemas'
import { transcribe, transcribeStream } from '@/server/bare/ops/transcribe'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { buildWhisperEngineConfig } from '@/server/bare/plugins/asr-ggml/config'
import { createAsrModelLogger } from '@/server/bare/plugins/asr-ggml/logging'

function createWhisperModel(
  modelId: string,
  modelPath: string,
  whisperConfig: WhisperConfig,
  vadModelPath?: string
) {
  const logger = createAsrModelLogger(modelId, ModelType.whispercppTranscription)

  const model = new ASRGgml({
    files: {
      model: modelPath,
      ...(vadModelPath && { vadModel: vadModelPath })
    },
    config: buildWhisperEngineConfig(whisperConfig),
    enableStats: true,
    logger
  })

  return { model }
}

export const whisperPlugin = definePlugin({
  modelType: ModelType.whispercppTranscription,
  displayName: 'Whisper (whisper.cpp)',
  addonPackage: ADDON_ASR,
  loadConfigSchema: whisperConfigSchema,

  async resolveConfig(cfg: WhisperConfig, ctx: ResolveContext) {
    const { vadModelSrc, ...whisperConfig } = cfg

    if (!vadModelSrc) {
      return { config: whisperConfig }
    }

    const vadModelPath = await ctx.resolveModelPath(vadModelSrc)
    return {
      config: whisperConfig,
      artifacts: { vadModelPath }
    }
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const whisperConfig = (params.modelConfig ?? {}) as WhisperConfig

    const { model } = createWhisperModel(
      params.modelId,
      params.modelPath,
      whisperConfig,
      params.artifacts?.['vadModelPath']
    )

    return { model }
  },

  handlers: {
    transcribe: defineHandler({
      requestSchema: transcribeRequestSchema,
      responseSchema: transcribeResponseSchema,
      streaming: true,
      // whisper.cpp addon exposes a model-wide hard cancel — compute
      // is interrupted on the currently-running transcription.
      cancel: { scope: 'model', hard: true },

      handler: async function* (request) {
        const metadata = request.metadata === true
        const stream = metadata
          ? transcribe(
              {
                modelId: request.modelId,
                audioChunk: request.audioChunk,
                prompt: request.prompt,
                metadata: true
              },
              request.requestId
            )
          : transcribe(
              {
                modelId: request.modelId,
                audioChunk: request.audioChunk,
                prompt: request.prompt
              },
              request.requestId
            )

        try {
          let result = await stream.next()
          while (!result.done) {
            yield metadata
              ? {
                  type: 'transcribe' as const,
                  segment: result.value as TranscribeSegment
                }
              : {
                  type: 'transcribe' as const,
                  text: result.value as string
                }
            result = await stream.next()
          }

          const { modelExecutionMs, stats } = result.value
          yield attachModelExecutionMs(
            {
              type: 'transcribe' as const,
              text: '',
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

    transcribeStream: defineDuplexHandler({
      requestSchema: transcribeStreamRequestSchema,
      responseSchema: transcribeStreamResponseSchema,
      streaming: true,
      duplex: true,
      // Same model-wide hard cancel surface as `transcribe` — both
      // route through the whisper.cpp addon.
      cancel: { scope: 'model', hard: true },

      handler: async function* (request, inputStream) {
        const streamOpts = {
          ...(request.emitVadEvents !== undefined && {
            emitVadEvents: request.emitVadEvents
          }),
          ...(request.endOfTurnSilenceMs !== undefined && {
            endOfTurnSilenceMs: request.endOfTurnSilenceMs
          }),
          ...(request.vadRunIntervalMs !== undefined && {
            vadRunIntervalMs: request.vadRunIntervalMs
          })
        }

        const metadata = request.metadata === true
        const iterator = metadata
          ? transcribeStream(
              request.modelId,
              inputStream,
              request.prompt,
              true,
              streamOpts,
              request.requestId
            )
          : transcribeStream(
              request.modelId,
              inputStream,
              request.prompt,
              false,
              streamOpts,
              request.requestId
            )

        for await (const value of iterator) {
          if (typeof value === 'object' && value !== null && 'type' in value) {
            if (value.type === 'vad') {
              yield {
                type: 'transcribeStream' as const,
                vad: {
                  speaking: value.speaking,
                  probability: value.probability
                }
              }
              continue
            }
            if (value.type === 'endOfTurn') {
              // The shared ASR op normalizes addon engine sources to the
              // stable SDK-level Whisper/Parakeet variants.
              if (value.source === 'parakeet') {
                continue
              }
              if (typeof value.silenceDurationMs !== 'number') {
                continue
              }
              yield {
                type: 'transcribeStream' as const,
                endOfTurn: {
                  source: 'whisper' as const,
                  silenceDurationMs: value.silenceDurationMs
                }
              }
              continue
            }
            continue
          }
          yield metadata
            ? {
                type: 'transcribeStream' as const,
                segment: value as TranscribeSegment
              }
            : {
                type: 'transcribeStream' as const,
                text: value as string
              }
        }

        yield {
          type: 'transcribeStream' as const,
          text: '',
          done: true
        }
      }
    })
  },

  logging: {
    module: asrAddonLogging,
    namespace: ADDON_ASR
  }
})
