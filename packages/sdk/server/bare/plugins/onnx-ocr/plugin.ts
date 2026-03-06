import {
  definePlugin,
  defineHandler,
  ocrStreamRequestSchema,
  ocrStreamResponseSchema,
  ModelType,
  type CreateModelParams,
  type PluginModelResult,
  type OCRConfig,
} from "@/schemas";
import { createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { ONNXOcr } from "@qvac/ocr-onnx";
import { ocr } from "@/server/bare/plugins/onnx-ocr/ops/ocr-stream";

function createOCRModel(
  modelId: string,
  detectorPath: string,
  recognizerPath: string,
  ocrConfig: OCRConfig,
) {
  const { dirPath } = parseModelPath(detectorPath);
  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "ocr");

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
  addonPackage: "@qvac/ocr-onnx",

  createModel(params: CreateModelParams): PluginModelResult {
    const ocrConfig = (params.modelConfig ?? {}) as OCRConfig;

    const { model, loader } = createOCRModel(
      params.modelId,
      params.artifacts?.["detectorModelPath"] ?? "",
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
        for await (const result of ocr({
          modelId: request.modelId,
          image: request.image,
          options: request.options,
        })) {
          yield {
            type: "ocrStream" as const,
            blocks: result.blocks,
            ...(result.stats && { stats: result.stats }),
          };
        }

        yield {
          type: "ocrStream" as const,
          blocks: [],
          done: true,
        };
      },
    }),
  },
});
