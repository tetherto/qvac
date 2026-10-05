import {
  definePlugin,
  defineHandler,
  decideRequestSchema,
  decideResponseSchema,
  ModelType,
  decideConfigBaseSchema,
  type CreateModelParams,
  type PluginModelResult,
  type DecideConfig
} from '@/schemas/index'
import { decide } from '@/plugins/ops/decide'
import { forwardModelExecution } from '@/profiling/model-execution'
import { DecideFailedError } from '@/errors/index'
import { transformDecideConfig } from '@/plugins/builtin/llamacpp-decision/transform'

const NATIVE_ADDON_MISSING =
  'The llamacpp-decision native addon is not linked. This build exposes the System One contract and a fixture-tested handler only.'

function unloadedModel() {
  return {
    async load(): Promise<void> {
      throw new DecideFailedError(NATIVE_ADDON_MISSING)
    },
    async unload(): Promise<void> {},
    async pause(): Promise<void> {},
    async run(): Promise<{
      iterate: () => AsyncIterable<unknown>
      await: () => Promise<unknown>
      cancel: () => Promise<void>
    }> {
      return {
        iterate() {
          return (async function* () {})()
        },
        async await() {
          throw new DecideFailedError(NATIVE_ADDON_MISSING)
        },
        async cancel() {}
      }
    },
    addon: {
      async cancel() {}
    }
  }
}

export const decisionPlugin = definePlugin({
  modelType: ModelType.llamacppDecision,
  displayName: 'Decision models (llama.cpp)',
  addonPackage: 'llamacpp-decision',
  loadConfigSchema: decideConfigBaseSchema,

  createModel(params: CreateModelParams): PluginModelResult {
    transformDecideConfig((params.modelConfig ?? {}) as DecideConfig)
    return { model: unloadedModel() }
  },

  handlers: {
    decide: defineHandler({
      requestSchema: decideRequestSchema,
      responseSchema: decideResponseSchema,
      streaming: false,
      cancel: { scope: 'model', hard: true },

      handler: async function (request) {
        const result = await decide(
          {
            modelId: request.modelId,
            state: request.state,
            questions: request.questions,
            ...(request.images !== undefined && { images: request.images })
          },
          request.requestId
        )

        return forwardModelExecution(
          {
            type: 'decide' as const,
            success: true,
            answers: result.answers,
            usage: result.usage
          },
          result
        )
      }
    })
  }
})
