import TranslationNmtcpp, {
  type TranslationNmtcppConfig,
  type Loader,
} from "@qvac/translation-nmtcpp";
import { type AnyModel } from "@/server/bare/registry/model-registry";
import { type NmtConfig } from "@/schemas";
import { createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { TranslationFailedError } from "@/utils/errors-server";
import { asLoader } from "@/server/bare/utils/loader-adapter";

export function createNmtModel(
  modelId: string,
  modelPath: string,
  nmtConfig: NmtConfig,
) {
  const { dirPath, basePath } = parseModelPath(modelPath);
  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "nmtcpp");

  const {
    mode,
    from,
    to,
    engine,
    beamsize,
    lengthpenalty,
    maxlength,
    repetitionpenalty,
    norepeatngramsize,
    temperature,
    topk,
    topp,
  } = nmtConfig;

  const args = {
    loader: asLoader<Loader>(loader),
    logger,
    modelName: basePath,
    diskPath: dirPath,
    params: {
      mode,
      srcLang: from,
      dstLang: to,
    },
  };

  const generationParams = {
    beamsize,
    lengthpenalty,
    maxlength,
    repetitionpenalty,
    norepeatngramsize,
    temperature,
    topk,
    topp,
  };

  const config: TranslationNmtcppConfig = {
    modelType: TranslationNmtcpp.ModelTypes[engine],
    ...generationParams,
    ...(nmtConfig.engine === "Bergamot" && {
      ...(nmtConfig.srcVocabPath && { srcVocabPath: nmtConfig.srcVocabPath }),
      ...(nmtConfig.dstVocabPath && { dstVocabPath: nmtConfig.dstVocabPath }),
      ...(nmtConfig.normalize !== undefined && {
        normalize: nmtConfig.normalize,
      }),
    }),
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
