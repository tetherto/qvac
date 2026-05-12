import ImgStableDiffusion, {
  type DiffusionFiles,
  type SdConfig,
} from "@qvac/diffusion-cpp";
import addonLogging from "@qvac/diffusion-cpp/addonLogging";
import {
  definePlugin,
  defineHandler,
  sdcppConfigSchema,
  diffusionRequestSchema,
  diffusionStreamResponseSchema,
  ModelType,
  ADDON_DIFFUSION,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type ResolveResult,
  type SdcppConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { diffusion } from "./ops/diffusion";

type DiffusionArtifactKey =
  | "clipLModelPath"
  | "clipGModelPath"
  | "t5XxlModelPath"
  | "llmModelPath"
  | "vaeModelPath"
  | "esrganModelPath";

export const diffusionPlugin = definePlugin({
  modelType: ModelType.sdcppGeneration,
  displayName: "Image Generation (stable-diffusion.cpp)",
  addonPackage: ADDON_DIFFUSION,
  loadConfigSchema: sdcppConfigSchema,

  async resolveConfig(
    cfg: SdcppConfig,
    ctx: ResolveContext,
  ): Promise<ResolveResult<SdcppConfig, DiffusionArtifactKey>> {
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
    const logger = createStreamLogger(modelId, ModelType.sdcppGeneration);
    registerAddonLogger(modelId, ModelType.sdcppGeneration, logger);

    const files: DiffusionFiles = {
      model: modelPath,
      ...(artifacts?.["clipLModelPath"] && { clipL: artifacts["clipLModelPath"] }),
      ...(artifacts?.["clipGModelPath"] && { clipG: artifacts["clipGModelPath"] }),
      ...(artifacts?.["t5XxlModelPath"] && { t5Xxl: artifacts["t5XxlModelPath"] }),
      ...(artifacts?.["llmModelPath"] && { llm: artifacts["llmModelPath"] }),
      ...(artifacts?.["vaeModelPath"] && { vae: artifacts["vaeModelPath"] }),
      ...(artifacts?.["esrganModelPath"] && { esrgan: artifacts["esrganModelPath"] }),
    };

    const { upscaler, ...rest } = config;
    const addonConfig = {
      ...rest,
      ...(upscaler?.tile_size !== undefined && { upscaler_tile_size: upscaler.tile_size }),
      ...(upscaler?.direct !== undefined && { upscaler_direct: upscaler.direct }),
      ...(upscaler?.offload_params_to_cpu !== undefined && {
        upscaler_offload_params_to_cpu: upscaler.offload_params_to_cpu,
      }),
      ...(upscaler?.threads !== undefined && { upscaler_threads: upscaler.threads }),
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
  },

  logging: {
    module: addonLogging,
    namespace: ModelType.sdcppGeneration,
  },
});
