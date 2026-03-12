import ImgStableDiffusion from "@qvac/diffusion-cpp";
import addonLogging from "@qvac/diffusion-cpp/addonLogging";
import {
  definePlugin,
  defineHandler,
  sdcppConfigSchema,
  generateImageRequestSchema,
  generateImageStreamResponseSchema,
  img2imgRequestSchema,
  ModelType,
  ADDON_DIFFUSION,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type ResolveResult,
  type SdcppConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import { generateImage } from "./ops/generate-image";
import { img2img } from "./ops/img2img";

type DiffusionArtifactKey =
  | "clipLModelPath"
  | "clipGModelPath"
  | "t5XxlModelPath"
  | "llmModelPath"
  | "vaeModelPath";

const SRC_TO_ARTIFACT = {
  clipLModelSrc: "clipLModelPath",
  clipGModelSrc: "clipGModelPath",
  t5XxlModelSrc: "t5XxlModelPath",
  llmModelSrc: "llmModelPath",
  vaeModelSrc: "vaeModelPath",
} as const satisfies Record<string, DiffusionArtifactKey>;

export const diffusionPlugin = definePlugin({
  modelType: ModelType.sdcppGeneration,
  displayName: "Image Generation (stable-diffusion.cpp)",
  addonPackage: ADDON_DIFFUSION,
  loadConfigSchema: sdcppConfigSchema,

  async resolveConfig(
    cfg: SdcppConfig,
    ctx: ResolveContext,
  ): Promise<ResolveResult<SdcppConfig, DiffusionArtifactKey>> {
    const srcKeys = new Set(Object.keys(SRC_TO_ARTIFACT));
    const config = Object.fromEntries(
      Object.entries(cfg).filter(([key]) => !srcKeys.has(key)),
    ) as SdcppConfig;

    const srcEntries = Object.entries(SRC_TO_ARTIFACT).filter(
      ([srcKey]) => cfg[srcKey as keyof typeof SRC_TO_ARTIFACT],
    );

    if (srcEntries.length === 0) {
      return { config };
    }

    const resolved = await Promise.all(
      srcEntries.map(([srcKey]) =>
        ctx.resolveModelPath(cfg[srcKey as keyof typeof SRC_TO_ARTIFACT]!),
      ),
    );

    const artifacts: Partial<Record<DiffusionArtifactKey, string>> = {};
    for (let i = 0; i < srcEntries.length; i++) {
      artifacts[srcEntries[i]![1]] = resolved[i];
    }

    return { config, artifacts };
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const { modelId, modelPath, modelConfig, artifacts } = params;
    const config = (modelConfig ?? {}) as SdcppConfig;
    const { dirPath, basePath } = parseModelPath(modelPath);
    const logger = createStreamLogger(modelId, ModelType.sdcppGeneration);
    registerAddonLogger(modelId, ModelType.sdcppGeneration, logger);

    const model = new ImgStableDiffusion(
      {
        diskPath: dirPath,
        modelName: basePath,
        logger,
        opts: { stats: true },
        clipLModel: artifacts?.["clipLModelPath"],
        clipGModel: artifacts?.["clipGModelPath"],
        t5XxlModel: artifacts?.["t5XxlModelPath"],
        llmModel: artifacts?.["llmModelPath"],
        vaeModel: artifacts?.["vaeModelPath"],
      },
      {
        threads: config.threads,
        device: config.device,
        prediction: config.prediction,
        wtype: config.wtype,
        rng: config.rng,
        schedule: config.schedule,
        clip_on_cpu: config.clip_on_cpu,
        vae_on_cpu: config.vae_on_cpu,
        vae_tiling: config.vae_tiling,
        flash_attn: config.flash_attn,
        verbosity: config.verbosity,
      },
    );

    return { model, loader: undefined };
  },

  handlers: {
    generateImageStream: defineHandler({
      requestSchema: generateImageRequestSchema,
      responseSchema: generateImageStreamResponseSchema,
      streaming: true,
      handler: generateImage,
    }),
    img2imgStream: defineHandler({
      requestSchema: img2imgRequestSchema,
      responseSchema: generateImageStreamResponseSchema,
      streaming: true,
      handler: img2img,
    }),
  },

  logging: {
    module: addonLogging,
    namespace: ModelType.sdcppGeneration,
  },
});
