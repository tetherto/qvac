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
  nmtConfigBaseSchema,
  ADDON_NMT,
  type ModelSrcInput,
  type CreateModelParams,
  type PluginModelResult,
  type NmtConfig,
  type ResolveContext,
  type ResolveResult,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { ModelLoadFailedError } from "@/utils/errors-server";
import { asLoader } from "@/server/bare/utils/loader-adapter";
import { translate } from "@/server/bare/ops/translate";

const BERGAMOT_CJK_LANG_PAIRS = ["enja", "enko", "enzh"];

function buildBergamotVocabSources(basePath: string, langPair: string) {
  if (BERGAMOT_CJK_LANG_PAIRS.includes(langPair)) {
    return {
      srcVocabSrc: `${basePath}srcvocab.${langPair}.spm`,
      dstVocabSrc: `${basePath}trgvocab.${langPair}.spm`,
    };
  }

  const sharedVocab = `${basePath}vocab.${langPair}.spm`;
  return { srcVocabSrc: sharedVocab, dstVocabSrc: sharedVocab };
}

function deriveBergamotVocabSources(modelSrc: string) {
  const match = modelSrc.match(
    /^pear:\/\/([a-f0-9]+)\/model\.([a-z]+)\.intgemm\.alphas\.bin$/,
  );
  if (!match?.[1] || !match[2]) return null;

  const basePath = `pear://${match[1]}/`;
  const langPair = match[2];
  return buildBergamotVocabSources(basePath, langPair);
}

function deriveBergamotRegistryVocabSources(modelSrc: string) {
  const match = modelSrc.match(
    /^(registry:\/\/.+\/)model\.([a-z]+)\.intgemm\.alphas\.bin$/,
  );
  if (!match?.[1] || !match[2]) return null;

  const basePath = match[1];
  const langPair = match[2];
  return buildBergamotVocabSources(basePath, langPair);
}

function createNmtModel(
  modelId: string,
  modelPath: string,
  nmtConfig: NmtConfig,
  srcVocabPath?: string,
  dstVocabPath?: string,
  pivotModelPath?: string,
  pivotSrcVocabPath?: string,
  pivotDstVocabPath?: string,
) {
  const { dirPath, basePath } = parseModelPath(modelPath);
  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, ModelType.nmtcppTranslation);
  registerAddonLogger(modelId, ModelType.nmtcppTranslation, logger);

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
      ...(srcVocabPath && { srcVocabPath }),
      ...(dstVocabPath && { dstVocabPath }),
      ...(nmtConfig.normalize !== undefined && {
        normalize: nmtConfig.normalize,
      }),
      // Add pivot model configuration if present
      ...(nmtConfig.pivotModel && {
        bergamotPivotModel: (() => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const {modelSrc, dstVocabSrc, srcVocabSrc, ...config} = nmtConfig.pivotModel
          const { dirPath, basePath } = parseModelPath(pivotModelPath!);
          return {
            loader: asLoader<Loader>(new FilesystemDL({ dirPath })),
            modelName: basePath,
            diskPath: dirPath,
            config: {
              ...config,
              srcVocabPath: pivotSrcVocabPath,
              dstVocabPath: pivotDstVocabPath
            }
          };
        })(),
      }),
    }),
  };

  const model = new TranslationNmtcpp(args, config);

  return { model, loader };
}

export const nmtPlugin = definePlugin({
  modelType: ModelType.nmtcppTranslation,
  displayName: "NMT (nmtcpp)",
  addonPackage: ADDON_NMT,
  loadConfigSchema: nmtConfigBaseSchema,

  async resolveConfig(
    cfg: Record<string, unknown>,
    ctx: ResolveContext,
  ): Promise<ResolveResult<Record<string, unknown>>> {
    const { srcVocabSrc, dstVocabSrc, ...nmtConfig } = cfg as {
      srcVocabSrc?: ModelSrcInput;
      dstVocabSrc?: ModelSrcInput;
      pivotModel?: { srcVocabSrc?: ModelSrcInput, dstVocabSrc?: ModelSrcInput, modelSrc: string };
    } & NmtConfig;


    if (nmtConfig.engine !== "Bergamot") {
      return { config: nmtConfig };
    }

    let srcSrc: ModelSrcInput | undefined = srcVocabSrc;
    let dstSrc: ModelSrcInput | undefined = dstVocabSrc;

    if (!srcSrc || !dstSrc) {
      const derived = ctx.modelSrc.startsWith("pear://")
        ? deriveBergamotVocabSources(ctx.modelSrc)
        : ctx.modelSrc.startsWith("registry://")
          ? deriveBergamotRegistryVocabSources(ctx.modelSrc)
          : null;
      if (derived) {
        srcSrc = srcSrc ?? derived.srcVocabSrc;
        dstSrc = dstSrc ?? derived.dstVocabSrc;
      }
    }

    if (!srcSrc || !dstSrc) {
      throw new ModelLoadFailedError(
        "Bergamot requires srcVocabSrc and dstVocabSrc. Provide them in modelConfig or use a pear:// or registry:// model source for auto-derivation.",
      );
    }

    const pivotModel = nmtConfig.pivotModel
    if (!pivotModel) {
      const [srcVocabPath, dstVocabPath] = await Promise.all([
        ctx.resolveModelPath(srcSrc),
        ctx.resolveModelPath(dstSrc),
      ]);

      return {
        config: nmtConfig,
        artifacts: { srcVocabPath, dstVocabPath },
      };
    }

    let pivotSrcSrc: ModelSrcInput | undefined = pivotModel.srcVocabSrc;
    let pivotDstSrc: ModelSrcInput | undefined = pivotModel.dstVocabSrc;

    if (!pivotSrcSrc || !pivotDstSrc) {
      const pivotDerived = pivotModel.modelSrc.startsWith("pear://")
          ? deriveBergamotVocabSources(pivotModel.modelSrc)
          : pivotModel.modelSrc.startsWith("registry://")
              ? deriveBergamotRegistryVocabSources(pivotModel.modelSrc)
              : null;
      if (pivotDerived) {
        pivotSrcSrc = pivotSrcSrc ?? pivotDerived.srcVocabSrc;
        pivotDstSrc = pivotDstSrc ?? pivotDerived.dstVocabSrc;
      }
    }

    if (!pivotSrcSrc || !pivotDstSrc) {
      throw new ModelLoadFailedError(
          "Bergamot pivot model requires srcVocabSrc and dstVocabSrc. Provide them in modelConfig or use a pear:// or registry:// model source for auto-derivation.",
      );
    }

    const [srcVocabPath, dstVocabPath, pivotSrcVocabPath, pivotDstVocabPath, pivotModelPath] = await Promise.all([
      ctx.resolveModelPath(srcSrc),
      ctx.resolveModelPath(dstSrc),
      ctx.resolveModelPath(pivotSrcSrc),
      ctx.resolveModelPath(pivotDstSrc),
      ctx.resolveModelPath(pivotModel.modelSrc),
    ]);

    return {
      config: nmtConfig,
      artifacts: { srcVocabPath, dstVocabPath, pivotSrcVocabPath, pivotDstVocabPath, pivotModelPath },
    };
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const nmtConfig = (params.modelConfig ?? {}) as NmtConfig;

    const { model, loader } = createNmtModel(
      params.modelId,
      params.modelPath,
      nmtConfig,
      params.artifacts?.["srcVocabPath"],
      params.artifacts?.["dstVocabPath"],
      params.artifacts?.["pivotModelPath"],
      params.artifacts?.["pivotSrcVocabPath"],
      params.artifacts?.["pivotDstVocabPath"],
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
    namespace: ModelType.nmtcppTranslation,
  },
});
