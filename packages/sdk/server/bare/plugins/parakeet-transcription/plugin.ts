import parakeetAddonLogging from "@qvac/transcription-parakeet/addonLogging";
import TranscriptionParakeet, {
  type ParakeetConfig,
  type TranscriptionParakeetArgs,
  type TranscriptionParakeetConfig,
} from "@qvac/transcription-parakeet";
import {
  definePlugin,
  defineHandler,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  ModelType,
  parakeetConfigSchema,
  ADDON_PARAKEET,
  type ModelSrcInput,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type ResolveResult,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import {
  ModelLoadFailedError,
  ParakeetArtifactsRequiredError,
} from "@/utils/errors-server";
import FilesystemDL from "@qvac/dl-filesystem";
import { transcribe } from "@/server/bare/ops/transcribe";
import { attachModelExecutionMs } from "@/profiling/model-execution";

type ParakeetModelConfig = {
  modelType?: string;
  maxThreads?: number;
  useGPU?: boolean;
  sampleRate?: number;
  channels?: number;
  captionEnabled?: boolean;
  timestampsEnabled?: boolean;
  // TDT
  parakeetEncoderSrc?: ModelSrcInput;
  parakeetEncoderDataSrc?: ModelSrcInput;
  parakeetDecoderSrc?: ModelSrcInput;
  parakeetVocabSrc?: ModelSrcInput;
  parakeetPreprocessorSrc?: ModelSrcInput;
  // CTC
  parakeetCtcModelSrc?: ModelSrcInput;
  parakeetCtcModelDataSrc?: ModelSrcInput;
  parakeetTokenizerSrc?: ModelSrcInput;
  // Sortformer
  parakeetSortformerSrc?: ModelSrcInput;
};

async function resolveTdtConfig(
  cfg: ParakeetModelConfig,
  ctx: ResolveContext,
): Promise<ResolveResult<ParakeetModelConfig>> {
  const {
    parakeetEncoderSrc,
    parakeetEncoderDataSrc,
    parakeetDecoderSrc,
    parakeetVocabSrc,
    parakeetPreprocessorSrc,
  } = cfg;

  if (
    !parakeetEncoderSrc ||
    !parakeetDecoderSrc ||
    !parakeetVocabSrc ||
    !parakeetPreprocessorSrc
  ) {
    throw new ParakeetArtifactsRequiredError(
      "TDT requires: parakeetEncoderSrc, parakeetDecoderSrc, parakeetVocabSrc, parakeetPreprocessorSrc",
    );
  }

  const resolve = ctx.resolveModelPath;
  const [
    encoderPath,
    encoderDataPath,
    decoderPath,
    vocabPath,
    preprocessorPath,
  ] = await Promise.all([
    resolve(parakeetEncoderSrc),
    parakeetEncoderDataSrc ? resolve(parakeetEncoderDataSrc) : undefined,
    resolve(parakeetDecoderSrc),
    resolve(parakeetVocabSrc),
    resolve(parakeetPreprocessorSrc),
  ]);

  return {
    config: cfg,
    artifacts: {
      encoderPath,
      ...(encoderDataPath !== undefined && { encoderDataPath }),
      ...(decoderPath !== undefined && { decoderPath }),
      ...(vocabPath !== undefined && { vocabPath }),
      ...(preprocessorPath !== undefined && { preprocessorPath }),
    },
  };
}

async function resolveCtcConfig(
  cfg: ParakeetModelConfig,
  ctx: ResolveContext,
): Promise<ResolveResult<ParakeetModelConfig>> {
  const { parakeetCtcModelSrc, parakeetCtcModelDataSrc, parakeetTokenizerSrc } =
    cfg;

  if (!parakeetCtcModelSrc || !parakeetTokenizerSrc) {
    throw new ParakeetArtifactsRequiredError(
      "CTC requires: parakeetCtcModelSrc, parakeetTokenizerSrc",
    );
  }

  const resolve = ctx.resolveModelPath;
  const [ctcModelPath, ctcModelDataPath, tokenizerPath] = await Promise.all([
    resolve(parakeetCtcModelSrc),
    parakeetCtcModelDataSrc ? resolve(parakeetCtcModelDataSrc) : undefined,
    resolve(parakeetTokenizerSrc),
  ]);

  return {
    config: cfg,
    artifacts: {
      ctcModelPath,
      ...(ctcModelDataPath !== undefined && { ctcModelDataPath }),
      ...(tokenizerPath !== undefined && { tokenizerPath }),
    },
  };
}

async function resolveSortformerConfig(
  cfg: ParakeetModelConfig,
  ctx: ResolveContext,
): Promise<ResolveResult<ParakeetModelConfig>> {
  const { parakeetSortformerSrc } = cfg;

  if (!parakeetSortformerSrc) {
    throw new ParakeetArtifactsRequiredError(
      "Sortformer requires: parakeetSortformerSrc",
    );
  }

  const resolve = ctx.resolveModelPath;
  const sortformerPath = await resolve(parakeetSortformerSrc);

  return {
    config: cfg,
    artifacts: {
      ...(sortformerPath !== undefined && { sortformerPath }),
    },
  };
}

function createParakeetModel(
  params: CreateModelParams,
  addonPathKey: string,
): PluginModelResult {
  const config = (params.modelConfig ?? {}) as ParakeetModelConfig;
  const artifacts = params.artifacts ?? {};
  const modelType = config.modelType ?? "tdt";
  const primaryPath = artifacts[addonPathKey] ?? params.modelPath;

  if (!primaryPath) {
    throw new ModelLoadFailedError(
      `Parakeet ${modelType} requires a model source`,
    );
  }

  const { dirPath } = parseModelPath(primaryPath);
  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(params.modelId, ModelType.parakeetTranscription);
  registerAddonLogger(params.modelId, ModelType.parakeetTranscription, logger);

  const addonConfig: TranscriptionParakeetConfig = {
    path: dirPath,
    [addonPathKey]: primaryPath,
    ...artifacts,
    parakeetConfig: {
      modelType,
      maxThreads: config.maxThreads,
      useGPU: config.useGPU,
      sampleRate: config.sampleRate,
      channels: config.channels,
      captionEnabled: config.captionEnabled,
      timestampsEnabled: config.timestampsEnabled,
    } as ParakeetConfig,
  };

  const model = new TranscriptionParakeet(
    {
      loader,
      logger,
      modelName: parseModelPath(dirPath).basePath,
      diskPath: dirPath,
      opts: { stats: true },
    } as TranscriptionParakeetArgs,
    addonConfig,
  );

  return { model, loader };
}

export const parakeetPlugin = definePlugin({
  modelType: ModelType.parakeetTranscription,
  displayName: "Parakeet (NVIDIA NeMo ONNX)",
  addonPackage: ADDON_PARAKEET,
  loadConfigSchema: parakeetConfigSchema,
  skipPrimaryModelPathValidation: true,

  async resolveConfig(
    cfg: ParakeetModelConfig,
    ctx: ResolveContext,
  ): Promise<ResolveResult<ParakeetModelConfig>> {
    const modelType = cfg.modelType ?? "tdt";

    if (modelType === "ctc") return resolveCtcConfig(cfg, ctx);
    if (modelType === "sortformer") return resolveSortformerConfig(cfg, ctx);
    return resolveTdtConfig(cfg, ctx);
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const modelType =
      ((params.modelConfig ?? {}) as ParakeetModelConfig).modelType ?? "tdt";

    if (modelType === "ctc") return createParakeetModel(params, "ctcModelPath");
    if (modelType === "sortformer")
      return createParakeetModel(params, "sortformerPath");
    return createParakeetModel(params, "encoderPath");
  },

  handlers: {
    transcribeStream: defineHandler({
      requestSchema: transcribeStreamRequestSchema,
      responseSchema: transcribeStreamResponseSchema,
      streaming: true,

      handler: async function* (request) {
        const stream = transcribe({
          modelId: request.modelId,
          audioChunk: request.audioChunk,
          prompt: request.prompt,
        });

        try {
          let result = await stream.next();
          while (!result.done) {
            yield {
              type: "transcribeStream" as const,
              text: result.value,
            };
            result = await stream.next();
          }

          const { modelExecutionMs, stats } = result.value;
          yield attachModelExecutionMs({
            type: "transcribeStream" as const,
            text: "",
            done: true,
            ...(stats && { stats }),
          }, modelExecutionMs);
        } finally {
          await stream.return?.(undefined as never);
        }
      },
    }),
  },

  logging: {
    module: parakeetAddonLogging,
    namespace: ModelType.parakeetTranscription,
  },
});
