import ONNXTTS from "@qvac/tts-onnx";
import { type AnyModel } from "@/server/bare/registry/model-registry";
import { type TtsConfig } from "@/schemas";
import { createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";

export type TtsModel = ONNXTTS;

export function createTtsModel(
  modelId: string,
  modelPath: string,
  ttsConfig: TtsConfig,
  ttsConfigModelPath: string,
  eSpeakDataPath: string,
) {
  const { dirPath, basePath: fileName } = parseModelPath(modelPath);
  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "tts");

  const args = {
    loader,
    logger,
    mainModelUrl: fileName,
    configJsonPath: parseModelPath(ttsConfigModelPath).basePath,
    cache: dirPath,
    eSpeakDataPath: eSpeakDataPath,
    opts: { stats: true },
  };

  const config = {
    language: ttsConfig.language,
  };

  const model = new ONNXTTS(args, config) as unknown as AnyModel;

  return { model, loader };
}
