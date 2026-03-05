import nmtAddonLogging from "@qvac/translation-nmtcpp/addonLogging";
import TranslationNmtcpp, {
  type TranslationNmtcppConfig,
  type Loader,
} from "@qvac/translation-nmtcpp";
import {
  definePlugin,
  defineHandler,
  translateRequestSchema,
  translateResponseSchema,
  ModelType,
  type CreateModelParams,
  type PluginModelResult,
  type NmtConfig,
} from "@/schemas";
import { ADDON_NAMESPACES, createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { TranslationFailedError } from "@/utils/errors-server";
import { asLoader } from "@/server/bare/utils/loader-adapter";
import { translate } from "@/server/bare/ops/translate";

function createNmtModel(
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

  if (config.modelType === TranslationNmtcpp.ModelTypes.IndicTrans) {
    throw new TranslationFailedError(
      "IndicTrans models are not supported with current NMT addon version.",
    );
  }

  const model = new TranslationNmtcpp(args, config);

  return { model, loader };
}

export const nmtPlugin = definePlugin({
  modelType: ModelType.nmtcppTranslation,
  displayName: "NMT (nmtcpp)",
  addonPackage: "@qvac/translation-nmtcpp",

  createModel(params: CreateModelParams): PluginModelResult {
    const nmtConfig = (params.modelConfig ?? {}) as NmtConfig;

    const { model, loader } = createNmtModel(
      params.modelId,
      params.modelPath,
      nmtConfig,
    );

    return { model, loader };
  },

  handlers: {
    translate: defineHandler({
      requestSchema: translateRequestSchema,
      responseSchema: translateResponseSchema,
      streaming: true,

      handler: async function* (request) {
        const stream = translate(request);
        let done = false;
        let stats;

        while (!done) {
          const result = await stream.next();

          if (result.done) {
            stats = result.value;
            done = true;
          } else {
            yield {
              type: "translate" as const,
              token: result.value,
            };
          }
        }

        yield {
          type: "translate" as const,
          token: "",
          done: true,
          ...(stats && { stats }),
        };
      },
    }),
  },

  logging: {
    module: nmtAddonLogging,
    namespace: ADDON_NAMESPACES.NMTCPP,
  },
});
