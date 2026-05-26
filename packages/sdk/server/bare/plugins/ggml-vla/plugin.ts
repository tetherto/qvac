import { VlaModel } from "@qvac/vla-ggml";
import {
  definePlugin,
  defineHandler,
  vlaConfigSchema,
  vlaRunRequestSchema,
  vlaRunResponseSchema,
  vlaHparamsRequestSchema,
  vlaHparamsResponseSchema,
  ModelType,
  ADDON_VLA,
  type CreateModelParams,
  type PluginModelResult,
  type VlaConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { vlaRun } from "./ops/vla-run";
import { vlaGetHparams } from "./ops/vla-hparams";

interface VlaLoadOptions {
  backend?: "auto" | "cpu";
}

interface VlaModelWrapper {
  load(force?: boolean): Promise<void>;
  unload?(): Promise<void>;
}

// The `@qvac/vla-ggml` VlaModel exposes `load({ backend })` rather than the
// `load(force?)` signature `PluginModel` expects. Wrap it so the plugin
// framework can call `load()` and have the configured backend flow through.
function wrapVlaModel(
  inner: VlaModel,
  loadOpts: VlaLoadOptions,
): VlaModel & VlaModelWrapper {
  const wrapper = inner as VlaModel & VlaModelWrapper;
  const originalLoad = wrapper.load.bind(wrapper);
  wrapper.load = function load(): Promise<void> {
    return originalLoad(loadOpts);
  };
  return wrapper;
}

export const vlaPlugin = definePlugin({
  modelType: ModelType.ggmlVla,
  displayName: "VLA (SmolVLA ggml)",
  addonPackage: ADDON_VLA,
  loadConfigSchema: vlaConfigSchema,

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as VlaConfig;
    const logger = createStreamLogger(params.modelId, ModelType.ggmlVla);
    registerAddonLogger(params.modelId, ModelType.ggmlVla, logger);

    const inner = new VlaModel({
      files: { model: [params.modelPath] },
      ...(config.verbosity !== undefined && {
        config: { verbosity: config.verbosity },
      }),
      logger,
      opts: { stats: true },
    });

    const backend = config.backend ?? "auto";
    const model = wrapVlaModel(inner, { backend });
    return { model };
  },

  handlers: {
    vlaRun: defineHandler({
      requestSchema: vlaRunRequestSchema,
      responseSchema: vlaRunResponseSchema,
      streaming: false,
      // The vla-ggml addon exposes a model-wide cancel(): the running ODE /
      // SmolLM2 prefill is interrupted. Mirrors the diffusion plugin's
      // cancel surface.
      cancel: { scope: "model", hard: true },
      handler: vlaRun,
    }),
    vlaHparams: defineHandler({
      requestSchema: vlaHparamsRequestSchema,
      responseSchema: vlaHparamsResponseSchema,
      streaming: false,
      cancel: { scope: "none" },
      handler: vlaGetHparams,
    }),
  },
});
