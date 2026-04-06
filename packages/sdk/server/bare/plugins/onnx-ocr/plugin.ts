import {
  definePlugin,
  defineHandler,
  ocrStreamRequestSchema,
  ocrStreamResponseSchema,
  ModelType,
  ocrConfigSchema,
  ADDON_OCR,
  type CreateModelParams,
  type PluginModelResult,
  type OCRConfig,
  type ResolveContext,
  type ResolveResult,
} from "@/schemas";
import { ModelLoadFailedError } from "@/utils/errors-server";
import { hyperdriveUrlSchema } from "@/schemas/load-model";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { ONNXOcr } from "@qvac/ocr-onnx";
import { ocr } from "@/server/bare/plugins/onnx-ocr/ops/ocr-stream";
import { attachModelExecutionMs } from "@/profiling/model-execution";
import { OCR_CRAFT_DETECTOR } from "@/models/registry";

const OCR_DETECTOR_FILENAME = "detector_craft.onnx";

function deriveDetectorSource(modelSrc: string): string | undefined {
  if (modelSrc.startsWith("pear://")) {
    const { key } = hyperdriveUrlSchema.parse(modelSrc);
    return `pear://${key}/${OCR_DETECTOR_FILENAME}`;
  }
  if (modelSrc.startsWith("registry://")) {
    return OCR_CRAFT_DETECTOR.src;
  }
  return undefined;
}

function createOCRModel(
  modelId: string,
  detectorPath: string,
  recognizerPath: string,
  ocrConfig: OCRConfig,
) {
  const { dirPath } = parseModelPath(detectorPath);
  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, ModelType.onnxOcr);
  registerAddonLogger(modelId, ModelType.onnxOcr, logger);

  const params = {
    pathDetector: detectorPath,
    pathRecognizer: recognizerPath,
    langList: ocrConfig.langList || ["en"],
    useGPU: ocrConfig.useGPU ?? true,
    ...(ocrConfig.timeout !== undefined && { timeout: ocrConfig.timeout }),
    ...(ocrConfig.pipelineMode !== undefined && {
      pipelineMode: ocrConfig.pipelineMode,
    }),
    ...(ocrConfig.magRatio !== undefined && { magRatio: ocrConfig.magRatio }),
    ...(ocrConfig.defaultRotationAngles !== undefined && {
      defaultRotationAngles: ocrConfig.defaultRotationAngles,
    }),
    ...(ocrConfig.contrastRetry !== undefined && {
      contrastRetry: ocrConfig.contrastRetry,
    }),
    ...(ocrConfig.lowConfidenceThreshold !== undefined && {
      lowConfidenceThreshold: ocrConfig.lowConfidenceThreshold,
    }),
    ...(ocrConfig.recognizerBatchSize !== undefined && {
      recognizerBatchSize: ocrConfig.recognizerBatchSize,
    }),
    ...(ocrConfig.decodingMethod !== undefined && {
      decodingMethod: ocrConfig.decodingMethod,
    }),
    ...(ocrConfig.straightenPages !== undefined && {
      straightenPages: ocrConfig.straightenPages,
    }),
  };

  const args = {
    loader: loader,
    logger,
    params,
    opts: { stats: true },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  const model = new ONNXOcr(args as any);

  return { model, loader };
}

export const ocrPlugin = definePlugin({
  modelType: ModelType.onnxOcr,
  displayName: "OCR (ONNX)",
  addonPackage: ADDON_OCR,
  loadConfigSchema: ocrConfigSchema,

  async resolveConfig(
    cfg: OCRConfig,
    ctx: ResolveContext,
  ): Promise<ResolveResult<Record<string, unknown>, "detectorModelPath">> {
    const { detectorModelSrc, ...ocrConfig } = cfg;

    const detectorSrc = detectorModelSrc ?? deriveDetectorSource(ctx.modelSrc);
    if (!detectorSrc) {
      throw new ModelLoadFailedError(
        "Detector model required for OCR. Use a hyperdrive source or provide detectorModelSrc",
      );
    }

    const detectorModelPath = await ctx.resolveModelPath(detectorSrc);
    return {
      config: ocrConfig,
      artifacts: { detectorModelPath },
    };
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const ocrConfig = (params.modelConfig ?? {}) as OCRConfig;
    const detectorModelPath = params.artifacts?.["detectorModelPath"];

    if (!detectorModelPath) {
      throw new ModelLoadFailedError(
        "Detector model path missing. Ensure detectorModelSrc is provided in modelConfig.",
      );
    }

    const { model, loader } = createOCRModel(
      params.modelId,
      detectorModelPath,
      params.modelPath, // recognizerPath
      ocrConfig,
    );

    return { model, loader };
  },

  handlers: {
    ocrStream: defineHandler({
      requestSchema: ocrStreamRequestSchema,
      responseSchema: ocrStreamResponseSchema,
      streaming: true,

      handler: async function* (request) {
        const stream = ocr({
          modelId: request.modelId,
          image: request.image,
          options: request.options,
        });
        try {
          let result = await stream.next();

          while (!result.done) {
            yield {
              type: "ocrStream" as const,
              blocks: result.value.blocks,
            };
            result = await stream.next();
          }

          const { modelExecutionMs, stats } = result.value;
          yield attachModelExecutionMs({
            type: "ocrStream" as const,
            blocks: [],
            done: true,
            ...(stats && { stats }),
          }, modelExecutionMs);
        } finally {
          await stream.return?.(undefined as never);
        }
      },
    }),
  },
});
