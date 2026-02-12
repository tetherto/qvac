import TranscriptionWhispercpp, {
  type WhisperConfig as TranscriptionWhisperConfig,
} from "@qvac/transcription-whispercpp";
import { type AnyModel } from "@/server/bare/registry/model-registry";
import { type WhisperConfig } from "@/schemas";
import { createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";

export type WhispercppModel = TranscriptionWhispercpp;

export function createWhisperModel(
  modelId: string,
  modelPath: string,
  whisperConfig: WhisperConfig,
  vadModelPath?: string,
) {
  const { dirPath, basePath } = parseModelPath(modelPath);

  // Handle VAD model path
  let vadModelName = "";

  const effectiveVadPath = vadModelPath || whisperConfig.vad_model_path;
  if (effectiveVadPath) {
    const vadParsed = parseModelPath(effectiveVadPath);
    vadModelName = vadParsed.basePath;
  }

  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "whispercpp");

  const args = {
    loader,
    logger,
    modelName: basePath,
    diskPath: dirPath,
    vadModelName,
    opts: {
      stats: false,
    },
  };

  const { contextParams, miscConfig, ...whisperParams } = whisperConfig;

  // Cast to upstream type - our stricter Zod schema is compatible at runtime
  const config = {
    whisperConfig: whisperParams as TranscriptionWhisperConfig,
    ...(contextParams && { contextParams }),
    ...(miscConfig && { miscConfig }),
  };

  const model = new TranscriptionWhispercpp(
    args,
    config,
  ) as unknown as AnyModel;

  return { model, loader };
}
