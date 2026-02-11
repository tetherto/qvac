import ONNXTTS from "@qvac/tts-onnx";
import { type AnyModel } from "@/server/bare/registry/model-registry";
import { type TtsConfig } from "@/schemas";
import { createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import type { ChatterboxPaths } from "@/schemas/load-model";

export type TtsModel = ONNXTTS;

export type TtsModelOptions =
  | {
      ttsConfigModelPath: string;
      eSpeakDataPath: string;
    }
  | {
      chatterboxPaths: ChatterboxPaths;
      /** Reference audio samples (float in [-1, 1]) for voice cloning. Required by addon at load time. */
      referenceAudioSamples?: number[];
    };

export function createTtsModel(
  modelId: string,
  modelPath: string,
  ttsConfig: TtsConfig,
  options: TtsModelOptions,
) {
  const logger = createStreamLogger(modelId, "tts");

  if ("chatterboxPaths" in options) {
    const p = options.chatterboxPaths;
    const args: Record<string, unknown> = {
      loader: null,
      logger,
      cache: ".",
      opts: { stats: true },
      tokenizerPath: p.tokenizerPath,
      speechEncoderPath: p.speechEncoderPath,
      embedTokensPath: p.embedTokensPath,
      conditionalDecoderPath: p.conditionalDecoderPath,
      languageModelPath: p.languageModelPath,
    };
    if (options.referenceAudioSamples?.length) {
      args["referenceAudio"] = new Float32Array(options.referenceAudioSamples);
    }
    const config = { language: ttsConfig.language };
    // Addon accepts Piper or Chatterbox args at runtime; .d.ts only declares Piper (ONNXTTSArgs)
    const model = new ONNXTTS(
      args as unknown as ConstructorParameters<typeof ONNXTTS>[0],
      config,
    ) as unknown as AnyModel;
    return { model, loader: null as unknown as FilesystemDL };
  }

  const { dirPath, basePath: fileName } = parseModelPath(modelPath);
  const loader = new FilesystemDL({ dirPath });
  const args = {
    loader,
    logger,
    mainModelUrl: fileName,
    configJsonPath: parseModelPath(options.ttsConfigModelPath).basePath,
    cache: dirPath,
    eSpeakDataPath: options.eSpeakDataPath,
    opts: { stats: true },
  };
  const config = { language: ttsConfig.language };
  const model = new ONNXTTS(args, config) as unknown as AnyModel;
  return { model, loader };
}
