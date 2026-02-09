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
  const { dirPath, basePath } = parseModelPath(modelPath);

  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "parakeet");

  // Cast args - our FilesystemDL loader is runtime-compatible with the expected Loader interface
  const args = {
    loader,
    logger,
    modelName: basePath,
    diskPath: dirPath,
  } as unknown as TranscriptionParakeetArgs;

  const config: UpstreamConfig = {
    parakeetConfig: parakeetConfig as TranscriptionParakeetConfig,
  };

  const model = new TranscriptionParakeet(
    args,
    config,
  ) as unknown as AnyModel;

  return { model, loader };
}
