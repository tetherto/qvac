import nmtAddonLogging from "@qvac/translation-nmtcpp/addonLogging";
import TranslationNmtcpp, {
  type TranslationNmtcppConfig,
  type TranslationNmtcppFiles,
} from "@qvac/translation-nmtcpp";
import {
  definePlugin,
  defineHandler,
  translateRequestSchema,
  translateResponseSchema,
  ModelType,
  nmtConfigBaseSchema,
  ADDON_NMT,
  BERGAMOT_CJK_LANG_PAIRS,
  type ModelSrcInput,
  type CreateModelParams,
  type PluginModelResult,
  type NmtConfig,
  type ResolveContext,
  type ResolveResult,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import path from "bare-path";
import { translate } from "@/server/bare/ops/translate";
import { attachModelExecutionMs } from "@/profiling/model-execution";
import {
  resolveBergamotVocab,
  type PivotModelConfig,
} from "@/server/bare/plugins/nmtcpp-translation/resolve-vocab";

/**
 * Derive absolute vocab paths from a resolved Bergamot model path.
 * Works for both companion-set layout (colocated files) and any layout where
 * vocab follows the standard naming convention beside the model binary.
 * Returns null if modelPath is not a recognisable Bergamot model.
 */
function deriveColocatedBergamotVocabPaths(modelPath: string) {
  const dirPath = path.dirname(modelPath);
  const basePath = path.basename(modelPath);
  const match = basePath.match(/^model\.([a-z]+)\.intgemm\.alphas\.bin$/);
  if (!match?.[1]) return null;

  const langPair = match[1];
  if (BERGAMOT_CJK_LANG_PAIRS.includes(langPair)) {
    return {
      srcVocabPath: path.join(dirPath, `srcvocab.${langPair}.spm`),
      dstVocabPath: path.join(dirPath, `trgvocab.${langPair}.spm`),
    };
  }

  const sharedPath = path.join(dirPath, `vocab.${langPair}.spm`);
  return { srcVocabPath: sharedPath, dstVocabPath: sharedPath };
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

  const files: TranslationNmtcppFiles = {
    model: modelPath,
    ...(srcVocabPath && { srcVocab: srcVocabPath }),
    ...(dstVocabPath && { dstVocab: dstVocabPath }),
    ...(pivotModelPath && { pivotModel: pivotModelPath }),
    ...(pivotSrcVocabPath && { pivotSrcVocab: pivotSrcVocabPath }),
    ...(pivotDstVocabPath && { pivotDstVocab: pivotDstVocabPath }),
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
      ...(nmtConfig.normalize !== undefined && {
        normalize: nmtConfig.normalize,
      }),
      ...(nmtConfig.pivotModel && pivotModelPath && {
        pivotConfig: (() => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { modelSrc, dstVocabSrc, srcVocabSrc, ...pivotGenConfig } = nmtConfig.pivotModel;
          return pivotGenConfig;
        })(),
      }),
    }),
  };

  const model = new TranslationNmtcpp({
    files,
    params: { mode, srcLang: from, dstLang: to },
    config,
    logger,
    opts: { stats: true },
  });

  return { model };
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
    const {
      srcVocabSrc,
      dstVocabSrc,
      pivotModel,
      ...nmtConfig
    } = cfg as {
      srcVocabSrc?: ModelSrcInput;
      dstVocabSrc?: ModelSrcInput;
      pivotModel?: PivotModelConfig;
    } & NmtConfig;

    if (nmtConfig.engine !== "Bergamot") {
      return { config: nmtConfig };
    }

    const bergamotConfig = { ...nmtConfig, ...(pivotModel && { pivotModel }) };

    return resolveBergamotVocab(
      bergamotConfig, ctx, srcVocabSrc, dstVocabSrc, pivotModel,
    );
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const nmtConfig = (params.modelConfig ?? {}) as NmtConfig;
    const artifacts = params.artifacts ?? {};
    const derived = deriveColocatedBergamotVocabPaths(params.modelPath);

    const srcVocabPath = artifacts["srcVocabPath"] ?? derived?.srcVocabPath;
    const dstVocabPath = artifacts["dstVocabPath"] ?? derived?.dstVocabPath;

    const pivotModelPath = artifacts["pivotModelPath"];
    const pivotDerived = pivotModelPath
      ? deriveColocatedBergamotVocabPaths(pivotModelPath)
      : null;
    const pivotSrcVocabPath = artifacts["pivotSrcVocabPath"] ?? pivotDerived?.srcVocabPath;
    const pivotDstVocabPath = artifacts["pivotDstVocabPath"] ?? pivotDerived?.dstVocabPath;

    const { model } = createNmtModel(
      params.modelId,
      params.modelPath,
      nmtConfig,
      srcVocabPath,
      dstVocabPath,
      pivotModelPath,
      pivotSrcVocabPath,
      pivotDstVocabPath,
    );

    return { model };
  },

  handlers: {
    translate: defineHandler({
      requestSchema: translateRequestSchema,
      responseSchema: translateResponseSchema,
      streaming: true,

      handler: async function* (request) {
        const stream = translate(request);
        try {
          let result = await stream.next();

          while (!result.done) {
            yield {
              type: "translate" as const,
              token: result.value,
            };
            result = await stream.next();
          }

          const { modelExecutionMs, stats } = result.value;
          yield attachModelExecutionMs({
            type: "translate" as const,
            token: "",
            done: true,
            ...(stats && { stats }),
          }, modelExecutionMs);
        } finally {
          await stream.return?.(undefined as never);
        }
      },
    }),
  },

  logging: {
    module: nmtAddonLogging,
    namespace: ModelType.nmtcppTranslation,
  },
});
