import type { OCRConfig } from "@/schemas/ocr";
import { type AnyModel } from "@/server/bare/registry/model-registry";
import { createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { ONNXOcr } from "@qvac/ocr-onnx";

export type OCRModel = ONNXOcr;

export function createOCRModel(
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
  };

  const args = {
    loader: loader,
    logger,
    params,
    opts: { stats: true },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  const model = new ONNXOcr(args as any) as unknown as AnyModel;

  return { model, loader };
}
