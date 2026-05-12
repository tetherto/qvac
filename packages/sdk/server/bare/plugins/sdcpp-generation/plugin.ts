import ImgStableDiffusion, {
  EsrganUpscaler,
  type DiffusionFiles,
  type EsrganUpscalerConfig,
  type SdConfig,
} from "@qvac/diffusion-cpp";
import addonLogging from "@qvac/diffusion-cpp/addonLogging";
import {
  definePlugin,
  defineHandler,
  sdcppConfigSchema,
  diffusionRequestSchema,
  diffusionStreamResponseSchema,
  upscaleRequestSchema,
  upscaleStreamResponseSchema,
  ModelType,
  ADDON_DIFFUSION,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type ResolveResult,
  type SdcppConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { ModelLoadFailedError } from "@/utils/errors-server";
import { diffusion } from "./ops/diffusion";
import { upscale } from "./ops/upscale";

type DiffusionArtifactKey =
  | "clipLModelPath"
  | "clipGModelPath"
  | "t5XxlModelPath"
  | "llmModelPath"
  | "vaeModelPath"
  | "esrganModelPath";

// Single source of truth for `SdcppConfig.upscaler.*` → addon-config key
// mapping. Used by both the diffusion-mode (post-generation upscaler) and the
// standalone-upscale-mode branches; keeping the mapping in one place avoids
// drift if `@qvac/diffusion-cpp` ever adds or renames an `upscaler_*` key.
function flattenUpscalerKeys(
  upscaler: SdcppConfig["upscaler"],
): Partial<EsrganUpscalerConfig> {
  if (!upscaler) return {};
  return {
    ...(upscaler.tile_size !== undefined && {
      upscaler_tile_size: upscaler.tile_size,
    }),
    ...(upscaler.direct !== undefined && {
      upscaler_direct: upscaler.direct,
    }),
    ...(upscaler.offload_params_to_cpu !== undefined && {
      upscaler_offload_params_to_cpu: upscaler.offload_params_to_cpu,
    }),
    ...(upscaler.threads !== undefined && {
      upscaler_threads: upscaler.threads,
    }),
  };
}

function toEsrganAddonConfig(config: SdcppConfig): EsrganUpscalerConfig {
  return {
    ...flattenUpscalerKeys(config.upscaler),
    ...(config.verbosity !== undefined && { verbosity: config.verbosity }),
  };
}

export const diffusionPlugin = definePlugin({
  modelType: ModelType.sdcppGeneration,
  displayName: "Image Generation & Upscaling (stable-diffusion.cpp)",
  addonPackage: ADDON_DIFFUSION,
  loadConfigSchema: sdcppConfigSchema,

  async resolveConfig(
    cfg: SdcppConfig,
    ctx: ResolveContext,
  ): Promise<ResolveResult<SdcppConfig, DiffusionArtifactKey>> {
    // Standalone-upscaler mode never references auxiliary models: the primary
    // modelSrc IS the ESRGAN file. Skip resolution to avoid downloading
    // unused encoders/VAEs and to keep load fast.
    if (cfg.mode === "upscale") {
      return { config: cfg };
    }

    const {
      clipLModelSrc, clipGModelSrc, t5XxlModelSrc,
      llmModelSrc, vaeModelSrc, upscaler, ...rest
    } = cfg;
    const { model_src: esrganModelSrc, ...upscalerRuntime } = upscaler ?? {};
    const runtimeConfig = {
      ...rest,
      ...(upscaler && { upscaler: upscalerRuntime }),
    } as SdcppConfig;

    const sources = {
      clipLModelSrc, clipGModelSrc, t5XxlModelSrc,
      llmModelSrc, vaeModelSrc, esrganModelSrc,
    };
    const hasSources = Object.values(sources).some(Boolean);

    if (!hasSources) {
      return { config: runtimeConfig };
    }

    const resolve = ctx.resolveModelPath;
    const [
      clipLModelPath, clipGModelPath, t5XxlModelPath,
      llmModelPath, vaeModelPath, esrganModelPath,
    ] = await Promise.all([
      clipLModelSrc ? resolve(clipLModelSrc) : undefined,
      clipGModelSrc ? resolve(clipGModelSrc) : undefined,
      t5XxlModelSrc ? resolve(t5XxlModelSrc) : undefined,
      llmModelSrc ? resolve(llmModelSrc) : undefined,
      vaeModelSrc ? resolve(vaeModelSrc) : undefined,
      esrganModelSrc ? resolve(esrganModelSrc) : undefined,
    ]);

    return {
      config: runtimeConfig,
      artifacts: {
        ...(clipLModelPath && { clipLModelPath }),
        ...(clipGModelPath && { clipGModelPath }),
        ...(t5XxlModelPath && { t5XxlModelPath }),
        ...(llmModelPath && { llmModelPath }),
        ...(vaeModelPath && { vaeModelPath }),
        ...(esrganModelPath && { esrganModelPath }),
      },
    };
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const { modelId, modelPath, modelConfig, artifacts } = params;
    const config = (modelConfig ?? {}) as SdcppConfig;

    // In diffusion mode the ESRGAN file (when post-generation upscale is
    // wanted) must come from upscaler.model_src — the primary modelPath is
    // the main diffusion checkpoint. Reject early with a clear error
    // instead of letting the native addon fail mid-load. Done before any
    // logger / native side-effects so callers can recover cleanly.
    if (
      config.mode !== "upscale" &&
      config.upscaler !== undefined &&
      !artifacts?.["esrganModelPath"]
    ) {
      throw new ModelLoadFailedError(
        "modelConfig.upscaler.model_src is required when modelConfig.upscaler " +
          "is set in diffusion mode. Provide the ESRGAN model, omit the " +
          "upscaler block, or switch to modelConfig.mode = 'upscale' to load " +
          "a standalone upscaler.",
      );
    }

    const logger = createStreamLogger(modelId, ModelType.sdcppGeneration);
    registerAddonLogger(modelId, ModelType.sdcppGeneration, logger);

    if (config.mode === "upscale") {
      const model = new EsrganUpscaler({
        files: { esrgan: modelPath },
        config: toEsrganAddonConfig(config),
        logger,
        opts: { stats: true },
      });
      return { model };
    }

    const files: DiffusionFiles = {
      model: modelPath,
      ...(artifacts?.["clipLModelPath"] && { clipL: artifacts["clipLModelPath"] }),
      ...(artifacts?.["clipGModelPath"] && { clipG: artifacts["clipGModelPath"] }),
      ...(artifacts?.["t5XxlModelPath"] && { t5Xxl: artifacts["t5XxlModelPath"] }),
      ...(artifacts?.["llmModelPath"] && { llm: artifacts["llmModelPath"] }),
      ...(artifacts?.["vaeModelPath"] && { vae: artifacts["vaeModelPath"] }),
      ...(artifacts?.["esrganModelPath"] && { esrgan: artifacts["esrganModelPath"] }),
    };

    // `mode` is consumed by this plugin to select the model class above; the
    // stable-diffusion.cpp native config does not understand it. Strip it
    // before forwarding `rest` to the addon.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { upscaler, mode, ...rest } = config;
    const addonConfig = {
      ...rest,
      ...flattenUpscalerKeys(upscaler),
    } as SdConfig;

    const model = new ImgStableDiffusion({
      files,
      config: addonConfig,
      logger,
      opts: { stats: true },
    });

    return { model };
  },

  handlers: {
    diffusionStream: defineHandler({
      requestSchema: diffusionRequestSchema,
      responseSchema: diffusionStreamResponseSchema,
      streaming: true,
      handler: diffusion,
    }),
    upscaleStream: defineHandler({
      requestSchema: upscaleRequestSchema,
      responseSchema: upscaleStreamResponseSchema,
      streaming: true,
      handler: upscale,
    }),
  },

  logging: {
    module: addonLogging,
    namespace: ModelType.sdcppGeneration,
  },
});
