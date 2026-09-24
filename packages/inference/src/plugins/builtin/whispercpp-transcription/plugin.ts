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
} from '@/schemas/index'
import { transcribe, transcribeStream } from '@/plugins/ops/transcribe'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { attachBackendDiagnostics } from '@/profiling/backend-diagnostics'
import { buildWhisperEngineConfig } from '@/plugins/builtin/asr-ggml/config'
import { createAsrModelLogger } from '@/plugins/builtin/asr-ggml/logging'

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

          const { modelExecutionMs, stats, diagnostics } = result.value
          // The field is what reaches an RPC client; the symbol is what the
          // profiling layer reads to set `event.backend`, as audiogen does.
          const terminal = attachModelExecutionMs(
            {
              type: 'transcribe' as const,
              text: '',
              done: true,
              ...(stats && { stats }),
              ...(diagnostics && { diagnostics })
            },
            modelExecutionMs
          )
          yield diagnostics ? attachBackendDiagnostics(terminal, diagnostics) : terminal
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

        try {
          let result = await iterator.next()
          while (!result.done) {
            const value = result.value
            if (typeof value === 'object' && value !== null && 'type' in value) {
              if (value.type === 'vad') {
                yield {
                  type: 'transcribeStream' as const,
                  vad: {
                    speaking: value.speaking,
                    probability: value.probability,
                    ...(value.source && { source: value.source })
                  }
                }
                result = await iterator.next()
                continue
              }
              if (value.type === 'endOfTurn') {
                // The shared ASR op normalizes addon engine sources to the
                // stable engine-level Whisper/Parakeet variants.
                if (value.source !== 'parakeet' && typeof value.silenceDurationMs === 'number') {
                  yield {
                    type: 'transcribeStream' as const,
                    endOfTurn: {
                      source: 'whisper' as const,
                      silenceDurationMs: value.silenceDurationMs
                    }
                  }
                }
                result = await iterator.next()
                continue
              }
              result = await iterator.next()
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
            result = await iterator.next()
          }

          const { modelExecutionMs, stats, diagnostics } = result.value
          // The field is what reaches an RPC client; the symbol is what the
          // profiling layer reads to set `event.backend`, as audiogen does.
          const terminal = attachModelExecutionMs(
            {
              type: 'transcribeStream' as const,
              text: '',
              done: true,
              ...(stats && { stats }),
              ...(diagnostics && { diagnostics })
            },
            modelExecutionMs
          )
          yield diagnostics ? attachBackendDiagnostics(terminal, diagnostics) : terminal
        } finally {
          await iterator.return?.(undefined as never)
        }
      }
    })
  },

  logging: {
    module: () => import('@qvac/asr-ggml/addonLogging'),
    namespace: ADDON_ASR
  }
})
