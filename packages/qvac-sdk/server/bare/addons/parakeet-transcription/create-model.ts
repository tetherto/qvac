import TranscriptionParakeet, {
  type ParakeetConfig as TranscriptionParakeetConfig,
  type TranscriptionParakeetArgs,
  type TranscriptionParakeetConfig as UpstreamConfig,
} from "@qvac/transcription-parakeet";
import { type AnyModel } from "@/server/bare/registry/model-registry";
import { type ParakeetConfig } from "@/schemas";
import { createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";

export type ParakeetModel = TranscriptionParakeet;

export function createParakeetModel(
  modelId: string,
  modelPath: string,
  parakeetConfig: ParakeetConfig,
) {
  const { dirPath } = parseModelPath(modelPath);

  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "parakeet");

  const args = {
    loader,
    logger,
    modelName: parseModelPath(dirPath).basePath,
    diskPath: dirPath,
  } as unknown as TranscriptionParakeetArgs;

  const config: UpstreamConfig = {
    path: dirPath,
    parakeetConfig: parakeetConfig as TranscriptionParakeetConfig,
  };

  const model = new TranscriptionParakeet(
    args,
    config,
  ) as unknown as AnyModel;

  return { model, loader };
}
