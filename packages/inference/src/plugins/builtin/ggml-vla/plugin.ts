import { VlaModel, type VlaEmbodimentSelector as AddonVlaEmbodimentSelector } from '@qvac/vla-ggml'
import {
  definePlugin,
  defineHandler,
  vlaConfigSchema,
  vlaRunRequestSchema,
  vlaRunResponseSchema,
  vlaHparamsRequestSchema,
  vlaHparamsResponseSchema,
  vlaSetEmbodimentRequestSchema,
  vlaSetEmbodimentResponseSchema,
  ModelType,
  ADDON_VLA,
  type CreateModelParams,
  type PluginModelResult,
  type VlaConfig
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger } from '@/logging/index'
import { vlaRun } from '@/plugins/builtin/ggml-vla/ops/vla-run'
import { vlaGetHparams } from '@/plugins/builtin/ggml-vla/ops/vla-hparams'
import { vlaSetEmbodiment } from '@/plugins/builtin/ggml-vla/ops/vla-set-embodiment'

interface VlaLoadOptions {
  backend?: 'auto' | 'cpu'
}

interface VlaModelWrapper {
  load(force?: boolean): Promise<void>
  unload?(): Promise<void>
}

// The `@qvac/vla-ggml` VlaModel exposes `load({ backend })` rather than the
// `load(force?)` signature `PluginModel` expects. Wrap it so the plugin
// framework can call `load()` and have the configured backend flow through.
function wrapVlaModel(inner: VlaModel, loadOpts: VlaLoadOptions): VlaModel & VlaModelWrapper {
  const wrapper = inner as VlaModel & VlaModelWrapper
  const originalLoad = wrapper.load.bind(wrapper)
  wrapper.load = function load(): Promise<void> {
    return originalLoad(loadOpts)
  }
  return wrapper
}

export const vlaPlugin = definePlugin({
  modelType: ModelType.ggmlVla,
  displayName: 'VLA (SmolVLA / π₀.₅ / GR00T ggml)',
  addonPackage: ADDON_VLA,
  loadConfigSchema: vlaConfigSchema,

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as VlaConfig
    const logger = createStreamLogger(params.modelId, ModelType.ggmlVla)
    registerAddonLogger(params.modelId, ModelType.ggmlVla, logger)

    const addonConfig = {
      ...(config.verbosity !== undefined && { verbosity: config.verbosity }),
      // The zod-inferred selector widens optional props with `| undefined`,
      // which exactOptionalPropertyTypes rejects against the addon's exact
      // shape — the runtime value is identical, so re-assert the addon type.
      ...(config.embodiment !== undefined && {
        embodiment: config.embodiment as AddonVlaEmbodimentSelector
      })
    }
    const inner = new VlaModel({
      files: { model: [params.modelPath] },
      ...(Object.keys(addonConfig).length > 0 && { config: addonConfig }),
      logger,
      opts: { stats: true }
    })

    const backend = config.backend ?? 'auto'
    const model = wrapVlaModel(inner, { backend })
    return { model }
  },

  handlers: {
    vlaRun: defineHandler({
      requestSchema: vlaRunRequestSchema,
      responseSchema: vlaRunResponseSchema,
      streaming: false,
      // The vla-ggml addon exposes a model-wide cancel(): the running ODE /
      // SmolLM2 prefill is interrupted. Mirrors the diffusion plugin's
      // cancel surface.
      cancel: { scope: 'model', hard: true },
      handler: vlaRun
    }),
    vlaHparams: defineHandler({
      requestSchema: vlaHparamsRequestSchema,
      responseSchema: vlaHparamsResponseSchema,
      streaming: false,
      cancel: { scope: 'none' },
      handler: vlaGetHparams
    }),
    vlaSetEmbodiment: defineHandler({
      requestSchema: vlaSetEmbodimentRequestSchema,
      responseSchema: vlaSetEmbodimentResponseSchema,
      streaming: false,
      // The addon refuses to switch while an inference job is in flight
      // (JOB_ALREADY_RUNNING), so there is nothing meaningful to cancel here.
      cancel: { scope: 'none' },
      handler: vlaSetEmbodiment
    })
  }
})
