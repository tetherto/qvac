import { BridgeDepth } from '@qvac/classification-ggml'
import { CAPABILITY_CONTRACTS } from '@/schemas/capabilities'
import {
  definePlugin,
  defineHandler,
  ModelType,
  ADDON_CLASSIFICATION,
  stereoDepthConfigSchema,
  estimateDisparityRequestSchema,
  estimateDisparityResponseSchema
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger } from '@/logging/index'
import { estimateDisparity } from './ops/estimate-disparity'

export const stereoDepthPlugin = definePlugin({
  modelType: ModelType.ggmlStereoDepth,
  displayName: 'Stereo depth (BridgeDepth)',
  addonPackage: ADDON_CLASSIFICATION,
  loadConfigSchema: stereoDepthConfigSchema,
  createModel(params) {
    const config = stereoDepthConfigSchema.parse(params.modelConfig ?? {})
    const logger = createStreamLogger(params.modelId, ModelType.ggmlStereoDepth)
    registerAddonLogger(params.modelId, ModelType.ggmlStereoDepth, logger)
    const model = new BridgeDepth({
      modelPath: params.modelPath,
      ...(config.backend !== undefined && { backend: config.backend }),
      ...(config.threads !== undefined && { threads: config.threads }),
      ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir }),
      logger
    })
    return { model }
  },
  provides: [CAPABILITY_CONTRACTS.stereoDepthEstimation],
  handlers: {
    estimateDisparity: defineHandler({
      requestSchema: estimateDisparityRequestSchema,
      responseSchema: estimateDisparityResponseSchema,
      streaming: false,
      // One native forward pass with no cancel point inside it. Cancelling
      // drops a queued request and discards the result of a running one.
      cancel: { scope: 'none' },
      handler: (request, _inputStream, context) => estimateDisparity(request, context)
    })
  }
})
