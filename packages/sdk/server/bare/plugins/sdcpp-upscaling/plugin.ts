import DiffusionCpp, {
  type EsrganUpscalerArgs,
  type EsrganUpscalerConfig,
} from "@qvac/diffusion-cpp";
import addonLogging from "@qvac/diffusion-cpp/addonLogging";
import {
  definePlugin,
  defineHandler,
  sdcppUpscalingConfigSchema,
  upscaleStreamRequestSchema,
  upscaleStreamResponseSchema,
  ModelType,
  ADDON_DIFFUSION,
  type CreateModelParams,
  type PluginModelResult,
  type SdcppUpscalingConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { upscale } from "@/server/bare/plugins/sdcpp-upscaling/ops/upscale";
import { ModelLoadFailedError } from "@/utils/errors-server";

type EsrganUpscalerConstructor = new (args: EsrganUpscalerArgs) => {
  load(): Promise<void>;
};

type DiffusionCppModule = {
  EsrganUpscaler?: EsrganUpscalerConstructor;
  default?: {
    EsrganUpscaler?: EsrganUpscalerConstructor;
  };
};

function getEsrganUpscalerConstructor(): EsrganUpscalerConstructor {
  const module = DiffusionCpp as unknown as DiffusionCppModule;
  const ctor = module.EsrganUpscaler ?? module.default?.EsrganUpscaler;
  if (!ctor) {
    throw new ModelLoadFailedError(
      "diffusion-cpp does not expose EsrganUpscaler",
    );
  }
  return ctor;
}

function toAddonConfig(config: SdcppUpscalingConfig): EsrganUpscalerConfig {
  return {
    ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir }),
    ...(config.tile_size !== undefined && { upscaler_tile_size: config.tile_size }),
    ...(config.direct !== undefined && { upscaler_direct: config.direct }),
    ...(config.offload_params_to_cpu !== undefined && {
      upscaler_offload_params_to_cpu: config.offload_params_to_cpu,
    }),
    ...(config.threads !== undefined && { upscaler_threads: config.threads }),
    ...(config.verbosity !== undefined && { verbosity: config.verbosity }),
  };
}

export const upscalerPlugin = definePlugin({
  modelType: ModelType.sdcppUpscaling,
  displayName: "Image Upscaling (stable-diffusion.cpp)",
  addonPackage: ADDON_DIFFUSION,
  loadConfigSchema: sdcppUpscalingConfigSchema,

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as SdcppUpscalingConfig;
    const logger = createStreamLogger(params.modelId, ModelType.sdcppUpscaling);
    registerAddonLogger(params.modelId, ModelType.sdcppUpscaling, logger);

    const EsrganUpscaler = getEsrganUpscalerConstructor();
    const model = new EsrganUpscaler({
      files: {
        esrgan: params.modelPath,
      },
      config: toAddonConfig(config),
      logger,
      opts: { stats: true },
    });

    return { model };
  },

  handlers: {
    upscaleStream: defineHandler({
      requestSchema: upscaleStreamRequestSchema,
      responseSchema: upscaleStreamResponseSchema,
      streaming: true,
      handler: upscale,
    }),
  },

  logging: {
    module: addonLogging,
    namespace: ModelType.sdcppUpscaling,
  },
});
