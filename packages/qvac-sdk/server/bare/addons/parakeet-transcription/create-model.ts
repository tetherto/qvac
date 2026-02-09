import TranscriptionParakeet, {
  type ParakeetConfig as TranscriptionParakeetConfig,
  type TranscriptionParakeetArgs,
  type TranscriptionParakeetConfig as UpstreamConfig,
} from "@qvac/transcription-parakeet";
import { type AnyModel } from "@/server/bare/registry/model-registry";
import { type ParakeetConfig } from "@/schemas";
import { createStreamLogger } from "@/logging";
import FilesystemDL from "@qvac/dl-filesystem";
import path from "bare-path";

export type ParakeetModel = TranscriptionParakeet;

export function createParakeetModel(
  modelId: string,
  modelPath: string,
  parakeetConfig: ParakeetConfig,
) {
  // modelPath points to a file inside the model directory
  // e.g., /path/to/models/parakeet-tdt-0.6b-v3-onnx/encoder-model.onnx
  //
  // The parakeet addon uses two paths:
  //   1. diskPath for downloadFiles() - must be the model directory (where ONNX files live)
  //      so existsSync(path.join(diskPath, 'encoder-model.onnx')) succeeds
  //   2. config.path for _createAddon/_loadModelWeights - the model directory path
  //      overrides _getModelFilePath() = path.join(diskPath, modelName)
  const modelDir = path.dirname(modelPath);

  const loader = new FilesystemDL({ dirPath: modelDir });
  const logger = createStreamLogger(modelId, "parakeet");

  // Cast args - our FilesystemDL loader is runtime-compatible with the expected Loader interface
  const args = {
    loader,
    logger,
    modelName: path.basename(modelDir),
    diskPath: modelDir,
  } as unknown as TranscriptionParakeetArgs;

  const config: UpstreamConfig = {
    path: modelDir,
    parakeetConfig: parakeetConfig as TranscriptionParakeetConfig,
  };

  const model = new TranscriptionParakeet(
    args,
    config,
  ) as unknown as AnyModel;

  return { model, loader };
}
