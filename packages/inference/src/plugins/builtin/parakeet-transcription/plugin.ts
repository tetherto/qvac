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
  type ResolveResult
} from '@/schemas/index'
import { ModelLoadFailedError, LegacyParakeetModelDeprecatedError } from '@/errors/index'
import { transcribe, transcribeStream } from '@/plugins/ops/transcribe'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { attachBackendDiagnostics } from '@/profiling/backend-diagnostics'
import { buildParakeetEngineConfig } from '@/plugins/builtin/asr-ggml/config'
import { createAsrModelLogger } from '@/plugins/builtin/asr-ggml/logging'

function resolveParakeetConfig(cfg: ParakeetConfig): Promise<ResolveResult<ParakeetConfig>> {
  const cfgRecord = cfg as unknown as Record<string, unknown>
  const legacyFields = LEGACY_PARAKEET_ONNX_MODEL_CONFIG_FIELDS.filter(
    (name) => cfgRecord[name] !== undefined
  )
  if (legacyFields.length > 0) {
    throw new LegacyParakeetModelDeprecatedError(legacyFields)
  }
  return Promise.resolve({ config: cfg })
}

function createParakeetModel(params: CreateModelParams): PluginModelResult {
  const config = (params.modelConfig ?? {}) as ParakeetConfig
  const modelPath = params.modelPath

  if (!modelPath) {
    throw new ModelLoadFailedError('Parakeet requires a GGUF model source')
  }

  const logger = createAsrModelLogger(params.modelId, ModelType.parakeetTranscription)

  const model = new ASRGgml({
    files: { model: modelPath },
    config: buildParakeetEngineConfig(config),
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

  resolveConfig(cfg: ParakeetConfig): Promise<ResolveResult<ParakeetConfig>> {
    return resolveParakeetConfig(cfg)
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
              if (value.type === 'endOfTurn') {
                yield {
                  type: 'transcribeStream' as const,
                  endOfTurn: { source: 'parakeet' as const }
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
