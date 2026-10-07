import {
  definePlugin,
  defineHandler,
  ModelType,
  ADDON_EMBEDDING,
  decisionsConfigSchema,
  decideRequestSchema,
  decideResponseSchema
} from '@/schemas/index'
import { createDecisionsModel } from './model'
import { decide } from './ops/decide'

export const decisionsPlugin = definePlugin({
  modelType: ModelType.llamacppDecisions,
  displayName: 'Laya decisions (llama.cpp)',
  addonPackage: ADDON_EMBEDDING,
  loadConfigSchema: decisionsConfigSchema,
  createModel: (params) => ({ model: createDecisionsModel(params) }),
  handlers: {
    decide: defineHandler({
      requestSchema: decideRequestSchema,
      responseSchema: decideResponseSchema,
      streaming: false,
      cancel: { scope: 'model', hard: true },
      handler: decide
    })
  },
  logging: {
    module: () => import('@qvac/embed-llamacpp/addonLogging'),
    namespace: ModelType.llamacppEmbedding
  }
})
