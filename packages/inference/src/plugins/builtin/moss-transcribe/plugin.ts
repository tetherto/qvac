import ASRGgml from '@qvac/asr-ggml'
import {
  definePlugin,
  defineHandler,
  transcribeRequestSchema,
  transcribeResponseSchema,
  ModelType,
  mossTranscribeConfigSchema,
  ADDON_ASR,
  type MossTranscribeConfig,
  type TranscribeSegment,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveResult
} from '@/schemas/index'
import { ModelLoadFailedError } from '@/errors/index'
import { transcribe } from '@/plugins/ops/transcribe'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { attachBackendDiagnostics } from '@/profiling/backend-diagnostics'
import { buildMossTranscribeEngineConfig } from '@/plugins/builtin/asr-ggml/config'
import { createAsrModelLogger } from '@/plugins/builtin/asr-ggml/logging'

function createMossTranscribeModel(params: CreateModelParams): PluginModelResult {
  const config = (params.modelConfig ?? {}) as MossTranscribeConfig
  const modelPath = params.modelPath

  if (!modelPath) {
    throw new ModelLoadFailedError('MOSS-Transcribe-Diarize requires a GGUF model source')
  }

  const logger = createAsrModelLogger(params.modelId, ModelType.mossTranscribe)

  const model = new ASRGgml({
    files: { model: modelPath },
    config: buildMossTranscribeEngineConfig(config),
    enableStats: true,
    logger
  })

  return { model }
}

export const mossTranscribePlugin = definePlugin({
  modelType: ModelType.mossTranscribe,
  displayName: 'MOSS-Transcribe-Diarize',
  addonPackage: ADDON_ASR,
  loadConfigSchema: mossTranscribeConfigSchema,

  resolveConfig(cfg: MossTranscribeConfig): Promise<ResolveResult<MossTranscribeConfig>> {
    return Promise.resolve({ config: cfg })
  },

  createModel(params: CreateModelParams): PluginModelResult {
    return createMossTranscribeModel(params)
  },

  handlers: {
    transcribe: defineHandler({
      requestSchema: transcribeRequestSchema,
      responseSchema: transcribeResponseSchema,
      streaming: true,
      cancel: { scope: 'model', hard: true },

      handler: async function* (request) {
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
    })
  },

  logging: {
    module: () => import('@qvac/asr-ggml/addonLogging'),
    namespace: ADDON_ASR
  }
})
