import {
  BERGAMOT_CJK_LANG_PAIRS,
  type ModelSrcInput,
  type NmtConfig,
  type ResolveContext,
  type ResolveResult,
} from "@/schemas";
import { ModelLoadFailedError } from "@/utils/errors-server";

export interface PivotModelConfig {
  modelSrc: string;
  srcVocabSrc?: ModelSrcInput;
  dstVocabSrc?: ModelSrcInput;
}

export function buildBergamotVocabSources(basePath: string, langPair: string) {
  if (BERGAMOT_CJK_LANG_PAIRS.includes(langPair)) {
    return {
      srcVocabSrc: `${basePath}srcvocab.${langPair}.spm`,
      dstVocabSrc: `${basePath}trgvocab.${langPair}.spm`,
    };
  }

  const sharedVocab = `${basePath}vocab.${langPair}.spm`;
  return { srcVocabSrc: sharedVocab, dstVocabSrc: sharedVocab };
}

export function deriveBergamotVocabSources(modelSrc: string) {
  const match = modelSrc.match(
    /^pear:\/\/([a-f0-9]+)\/model\.([a-z]+)\.intgemm\.alphas\.bin$/,
  );
  if (!match?.[1] || !match[2]) return null;

  const basePath = `pear://${match[1]}/`;
  const langPair = match[2];
  return buildBergamotVocabSources(basePath, langPair);
}

export function deriveBergamotRegistryVocabSources(modelSrc: string) {
  const match = modelSrc.match(
    /^(registry:\/\/.+\/)model\.([a-z]+)\.intgemm\.alphas\.bin$/,
  );
  if (!match?.[1] || !match[2]) return null;

  const basePath = match[1];
  const langPair = match[2];
  return buildBergamotVocabSources(basePath, langPair);
}

/**
 * Resolves Bergamot vocab sources to absolute filesystem paths via the SDK
 * resolver context, optionally including a pivot model.
 *
 * For `registry://` sources with auto-derived vocabs, this skips per-vocab
 * resolution because the companion-set download already colocates the vocabs
 * next to the primary model under `sets/<setKey>/`. `createModel` then derives
 * the colocated paths via `deriveColocatedBergamotVocabPaths`. This avoids a
 * redundant flat-cache copy and sidesteps the dedup edge case in QVAC-18420
 * where two directions of a bidirectional pair ship the same vocab blob under
 * distinct registry paths and only one survives sha256 dedup.
 */
export async function resolveBergamotVocab(
  nmtConfig: NmtConfig,
  ctx: ResolveContext,
  srcVocabSrc: ModelSrcInput | undefined,
  dstVocabSrc: ModelSrcInput | undefined,
  pivotModel?: PivotModelConfig,
): Promise<ResolveResult<Record<string, unknown>>> {
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

  if (!pivotModel) {
    const modelIsRegistry = ctx.modelSrc.startsWith("registry://");
    const vocabsAreDerived = !srcVocabSrc && !dstVocabSrc;
    if (modelIsRegistry && vocabsAreDerived) {
      return { config: nmtConfig };
    }

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

  const modelIsRegistry = ctx.modelSrc.startsWith("registry://");
  const pivotIsRegistry = pivotModel.modelSrc.startsWith("registry://");
  const primaryVocabsAreDerived = !srcVocabSrc && !dstVocabSrc;
  const pivotVocabsAreDerived =
    !pivotModel.srcVocabSrc && !pivotModel.dstVocabSrc;
  if (
    modelIsRegistry &&
    pivotIsRegistry &&
    primaryVocabsAreDerived &&
    pivotVocabsAreDerived
  ) {
    const pivotModelPath = await ctx.resolveModelPath(pivotModel.modelSrc);
    return { config: nmtConfig, artifacts: { pivotModelPath } };
  }

  const [
    srcVocabPath,
    dstVocabPath,
    pivotSrcVocabPath,
    pivotDstVocabPath,
    pivotModelPath,
  ] = await Promise.all([
    ctx.resolveModelPath(srcSrc),
    ctx.resolveModelPath(dstSrc),
    ctx.resolveModelPath(pivotSrcSrc),
    ctx.resolveModelPath(pivotDstSrc),
    ctx.resolveModelPath(pivotModel.modelSrc),
  ]);

  return {
    config: nmtConfig,
    artifacts: {
      srcVocabPath,
      dstVocabPath,
      pivotSrcVocabPath,
      pivotDstVocabPath,
      pivotModelPath,
    },
  };
}
