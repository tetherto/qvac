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
  parakeetLoadConfigSchema,
  LEGACY_PARAKEET_ONNX_MODEL_CONFIG_FIELDS,
  ADDON_ASR,
  type ParakeetConfig,
  type TranscribeSegment,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type ResolveResult
} from '@/schemas/index'
import { ModelLoadFailedError, LegacyParakeetModelDeprecatedError } from '@/errors/index'
import { transcribe, transcribeStream } from '@/plugins/ops/transcribe'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { attachBackendDiagnostics } from '@/profiling/backend-diagnostics'
import {
  buildParakeetEngineConfig,
  SPEAKER_ATTRIBUTION_MODEL_PATH
} from '@/plugins/builtin/asr-ggml/config'
import { parakeetFitRequest } from '@/plugins/builtin/asr-ggml/fit'
import { withCoremlLongFormDefault } from '@/plugins/builtin/asr-ggml/coreml-long-form'
import { getRuntimeContext } from '@/runtime/state'
import { createAsrModelLogger } from '@/plugins/builtin/asr-ggml/logging'

/**
 * Rejects the pre-0.6 ONNX fields and resolves the speaker-attribution
 * diarization model, when one is configured, to the path the addon loads
 * beside the ASR model. The config keeps its `modelSrc`, as the stored load
 * config; the engine config builder swaps in the resolved path.
 */
async function resolveParakeetConfig(
  cfg: ParakeetConfig,
  ctx: ResolveContext
): Promise<ResolveResult<ParakeetConfig, typeof SPEAKER_ATTRIBUTION_MODEL_PATH>> {
  const cfgRecord = cfg as unknown as Record<string, unknown>
  const legacyFields = LEGACY_PARAKEET_ONNX_MODEL_CONFIG_FIELDS.filter(
    (name) => cfgRecord[name] !== undefined
  )
  if (legacyFields.length > 0) {
    throw new LegacyParakeetModelDeprecatedError(legacyFields)
  }
  if (cfg.speakerAttribution === undefined) {
    return { config: cfg }
  }
  const diarizationModelPath = await ctx.resolveModelPath(cfg.speakerAttribution.modelSrc)
  return {
    config: cfg,
    artifacts: { [SPEAKER_ATTRIBUTION_MODEL_PATH]: diarizationModelPath }
  }
}

/**
 * The addon config a load runs with: the stored load config, plus the Core ML
 * long-form default (`withCoremlLongFormDefault`) for the GGUF at `modelPath`.
 */
export function parakeetLoadEngineConfig(
  params: Pick<CreateModelParams, 'modelPath' | 'modelConfig' | 'artifacts'>,
  platform: string | undefined = getRuntimeContext().platform
) {
  const config = withCoremlLongFormDefault(
    (params.modelConfig ?? {}) as ParakeetConfig,
    params.modelPath,
    platform
  )
  return buildParakeetEngineConfig(config, params.artifacts)
}

function createParakeetModel(params: CreateModelParams): PluginModelResult {
  const modelPath = params.modelPath

  if (!modelPath) {
    throw new ModelLoadFailedError('Parakeet requires a GGUF model source')
  }

  const logger = createAsrModelLogger(params.modelId, ModelType.parakeetTranscription)

  const model = new ASRGgml({
    files: { model: modelPath },
    config: parakeetLoadEngineConfig(params),
    enableStats: true,
    logger
  })

  return { model }
}

export const parakeetPlugin = definePlugin({
  modelType: ModelType.parakeetTranscription,
  displayName: 'Parakeet (NVIDIA NeMo GGML)',
  addonPackage: ADDON_ASR,
  loadConfigSchema: parakeetLoadConfigSchema,
  fitRequest: parakeetFitRequest,
  assessFit: ASRGgml.assessFit,

  resolveConfig(cfg: ParakeetConfig, ctx: ResolveContext) {
    return resolveParakeetConfig(cfg, ctx)
  },

  createModel(params: CreateModelParams): PluginModelResult {
    return createParakeetModel(params)
  },

  handlers: {
    transcribe: defineHandler({
      requestSchema: transcribeRequestSchema,
      responseSchema: transcribeResponseSchema,
      streaming: true,
      cancel: { scope: 'model', hard: true },

      handler: async function* (request) {
        // The native serializer emits start/end/id/toAppend/isEndOfTurn/
        // startsWord on every segment, so metadata mode is forwarded exactly
        // as the whisper plugin does. Branching the call keeps the op's
        // `metadata: true` overload, which is what types results as segments.
        const metadata = request.metadata === true
        const stream = metadata
          ? transcribe(
              {
                modelId: request.modelId,
                audioChunk: request.audioChunk,
                prompt: request.prompt,
                hotwords: request.hotwords,
                maxNewTokens: request.maxNewTokens,
                metadata: true
              },
              request.requestId
            )
          : transcribe(
              {
                modelId: request.modelId,
                audioChunk: request.audioChunk,
                prompt: request.prompt,
                hotwords: request.hotwords,
                maxNewTokens: request.maxNewTokens
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
      cancel: { scope: 'model', hard: true },

      // TODO(QVAC-17869-followup): wire `AbortSignal` through the duplex
      // handler signature so the handler learns about consumer disconnects
      // without depending on `inputStream.end()` (which does not fire if the
      // client drops packets while TCP stays alive). Under sustained slow
      // consumers, `runStreaming` may buffer between the server generator and
      // the duplex RPC writer — backpressure is not yet characterised. Pair
      // the fix with request-lifecycle `cancel({ requestId })` routing.
      handler: async function* (request, inputStream) {
        const metadata = request.metadata === true
        const streamOpts = {
          ...(request.parakeetStreamingConfig && {
            parakeetStreamingConfig: request.parakeetStreamingConfig
          })
        }

        const iterator = metadata
          ? transcribeStream(
              request.modelId,
              inputStream,
              undefined,
              true,
              streamOpts,
              request.requestId
            )
          : transcribeStream(
              request.modelId,
              inputStream,
              undefined,
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
                    ...(value.source && { source: value.source }),
                    ...(value.timestamp !== undefined && { timestamp: value.timestamp }),
                    ...(value.chunkIndex !== undefined && { chunkIndex: value.chunkIndex }),
                    ...(value.speakerId !== undefined && { speakerId: value.speakerId })
                  }
                }
              } else if (value.type === 'endOfTurn') {
                // The shared op already normalized the addon event to the
                // parakeet variant; forward the native timing and confidence
                // only when the engine sent them.
                const { timestamp, chunkIndex, confidence } =
                  value.source === 'parakeet' ? value : {}
                yield {
                  type: 'transcribeStream' as const,
                  endOfTurn: {
                    source: 'parakeet' as const,
                    ...(timestamp !== undefined && { timestamp }),
                    ...(chunkIndex !== undefined && { chunkIndex }),
                    ...(confidence !== undefined && { confidence })
                  }
                }
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
