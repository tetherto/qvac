import TranslationNmtcpp from "@qvac/translation-nmtcpp";
import { type AnyModel } from "@/server/bare/registry/model-registry";
import { type NmtConfig, INDICTRANS_LANGUAGES } from "@/schemas";
import { createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { TranslationFailedError } from "@/utils/errors-server";
export function createNmtModel(
  modelId: string,
  modelPath: string,
  nmtConfig: NmtConfig,
) {
  const { dirPath, basePath } = parseModelPath(modelPath);
  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "nmtcpp");

  const { mode, from, to, ...generationParams } = nmtConfig;

  const args = {
    loader,
    logger,
    modelName: basePath,
    diskPath: dirPath,
    params: {
      mode,
      srcLang: from,
      dstLang: to,
    },
  };

  const config = {
    modelType:
      (INDICTRANS_LANGUAGES as readonly string[]).includes(from) &&
      (INDICTRANS_LANGUAGES as readonly string[]).includes(to)
        ? TranslationNmtcpp.ModelTypes.IndicTrans
        : TranslationNmtcpp.ModelTypes.Opus,
    ...generationParams,
  };

  // Fail fast if model type is IndicTrans
  if (config.modelType === TranslationNmtcpp.ModelTypes.IndicTrans) {
    throw new TranslationFailedError(
      "IndicTrans models are not supported with current NMT addon version.",
    );
  }

  const model = new TranslationNmtcpp(args, config) as unknown as AnyModel;

  return { model, loader };
}
