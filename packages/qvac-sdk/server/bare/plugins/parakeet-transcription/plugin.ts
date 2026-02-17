import parakeetAddonLogging from "@qvac/transcription-parakeet/addonLogging";
import TranscriptionParakeet, {
  type ParakeetConfig as TranscriptionParakeetConfig,
  type TranscriptionParakeetArgs,
  type TranscriptionParakeetConfig as UpstreamConfig,
} from "@qvac/transcription-parakeet";
import {
  definePlugin,
  ModelType,
  type CreateModelParams,
  type PluginModelResult,
  type ParakeetConfig,
} from "@/schemas";
import { ADDON_NAMESPACES, createStreamLogger } from "@/logging";
import {
  parseModelPath,
  generateShortHash,
  getModelsCacheDir,
} from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import fs from "bare-fs";
import path from "bare-path";
import { transcribe } from "@/server/bare/plugins/parakeet-transcription/ops/transcribe-stream";
import { createTranscribeStreamHandler } from "@/server/bare/utils/transcription-handler";

/**
 * Try to symlink; fall back to copy if symlink fails (e.g. cross-device).
 */
function ensureLinkSync(target: string, linkPath: string): void {
  try {
    fs.symlinkSync(target, linkPath);
  } catch {
    fs.copyFileSync(target, linkPath);
  }
}

/**
 * Assemble individually-resolved model files into a single directory that
 * the addon's FilesystemDL can load from.
 */
function assembleModelDir(
  encoderPath: string,
  artifacts: Record<string, string>,
): string {
  const cacheDir = getModelsCacheDir();
  const hashInput = [
    encoderPath,
    artifacts["parakeetEncoderDataPath"] ?? "",
    artifacts["parakeetDecoderPath"] ?? "",
    artifacts["parakeetVocabPath"] ?? "",
    artifacts["parakeetPreprocessorPath"] ?? "",
  ].join(":");
  const modelDir = path.join(
    cacheDir,
    `parakeet_${generateShortHash(hashInput)}`,
  );

  fs.mkdirSync(modelDir, { recursive: true });

  const fileMappings: [string | undefined, string][] = [
    [encoderPath, "encoder-model.onnx"],
    [artifacts["parakeetEncoderDataPath"], "encoder-model.onnx.data"],
    [artifacts["parakeetDecoderPath"], "decoder_joint-model.onnx"],
    [artifacts["parakeetVocabPath"], "vocab.txt"],
    [artifacts["parakeetPreprocessorPath"], "preprocessor.onnx"],
  ];

  for (const [srcPath, destName] of fileMappings) {
    if (!srcPath) continue;
    const destPath = path.join(modelDir, destName);
    if (!fs.existsSync(destPath)) {
      ensureLinkSync(srcPath, destPath);
    }
  }

  return modelDir;
}

function createParakeetModel(
  modelId: string,
  modelPath: string,
  parakeetConfig: ParakeetConfig,
  artifacts?: Record<string, string>,
) {
  let dirPath: string;

  if (
    artifacts &&
    (artifacts["parakeetEncoderDataPath"] ||
      artifacts["parakeetDecoderPath"] ||
      artifacts["parakeetVocabPath"] ||
      artifacts["parakeetPreprocessorPath"])
  ) {
    // Individual files were resolved separately — assemble into a directory
    dirPath = assembleModelDir(modelPath, artifacts);
  } else {
    // Legacy path: modelPath points to a file inside an existing model directory
    dirPath = parseModelPath(modelPath).dirPath;
  }

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

  const model = new TranscriptionParakeet(args, config);

  return { model, loader };
}

export const parakeetPlugin = definePlugin({
  modelType: ModelType.parakeetTranscription,
  displayName: "Parakeet (NVIDIA NeMo ONNX)",
  addonPackage: "@qvac/transcription-parakeet",

  createModel(params: CreateModelParams): PluginModelResult {
    const parakeetConfig = (params.modelConfig ?? {}) as ParakeetConfig;

    const { model, loader } = createParakeetModel(
      params.modelId,
      params.modelPath,
      parakeetConfig,
      params.artifacts,
    );

    return { model, loader };
  },

  handlers: {
    transcribeStream: createTranscribeStreamHandler(transcribe),
  },

  logging: {
    module: parakeetAddonLogging,
    namespace: ADDON_NAMESPACES.PARAKEET,
  },
});
