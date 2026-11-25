import {
  BERGAMOT_CJK_LANG_PAIRS,
  type ModelSrcInput,
  type NmtConfig,
  type ResolveContext,
  type ResolveResult
} from '@/schemas/index'
import { ModelLoadFailedError } from '@/errors/index'

export interface PivotModelConfig {
  modelSrc: string
  srcVocabSrc?: ModelSrcInput
  dstVocabSrc?: ModelSrcInput
}

/**
 * Vocab sources beside a Bergamot model. A pair-named model
 * (`model.<pair>.intgemm.alphas.bin`) ships `vocab.<pair>.spm` (CJK pairs: a
 * `srcvocab`/`trgvocab` split); a multilingual pack (`model.intgemm.alphas.bin`,
 * `langPair` empty) ships one shared `vocab.spm`.
 */
export function buildBergamotVocabSources(basePath: string, langPair: string) {
  if (BERGAMOT_CJK_LANG_PAIRS.includes(langPair)) {
    return {
      srcVocabSrc: `${basePath}srcvocab.${langPair}.spm`,
      dstVocabSrc: `${basePath}trgvocab.${langPair}.spm`
    }
  }

  const sharedVocab = langPair ? `${basePath}vocab.${langPair}.spm` : `${basePath}vocab.spm`
  return { srcVocabSrc: sharedVocab, dstVocabSrc: sharedVocab }
}

function fromModelMatch(match: RegExpMatchArray | null) {
  if (!match?.[1]) return null
  return buildBergamotVocabSources(match[1], match[2] ?? '')
}

export function deriveBergamotVocabSources(modelSrc: string) {
  return fromModelMatch(
    modelSrc.match(/^(pear:\/\/[a-f0-9]+\/(?:.+\/)?)model\.(?:([a-z]+)\.)?intgemm\.alphas\.bin$/)
  )
}

export function deriveBergamotRegistryVocabSources(modelSrc: string) {
  return fromModelMatch(
    modelSrc.match(/^(registry:\/\/.+\/)model\.(?:([a-z]+)\.)?intgemm\.alphas\.bin$/)
  )
}

/** A model file on disk (absolute or relative, POSIX or Windows separators). */
export function deriveBergamotLocalVocabSources(modelSrc: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(modelSrc)) return null
  return fromModelMatch(modelSrc.match(/^(.*[/\\])model\.(?:([a-z]+)\.)?intgemm\.alphas\.bin$/))
}

/** Vocab sources derived beside a registry://, pear:// or local model source. */
export function deriveBergamotVocabSourcesFor(modelSrc: string) {
  if (modelSrc.startsWith('pear://')) return deriveBergamotVocabSources(modelSrc)
  if (modelSrc.startsWith('registry://')) return deriveBergamotRegistryVocabSources(modelSrc)
  return deriveBergamotLocalVocabSources(modelSrc)
}

/**
 * Resolves Bergamot vocab sources to absolute filesystem paths via the
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
  pivotModel?: PivotModelConfig
): Promise<ResolveResult<Record<string, unknown>>> {
  let srcSrc: ModelSrcInput | undefined = srcVocabSrc
  let dstSrc: ModelSrcInput | undefined = dstVocabSrc

  if (!srcSrc || !dstSrc) {
    const derived = deriveBergamotVocabSourcesFor(ctx.modelSrc)
    if (derived) {
      srcSrc = srcSrc ?? derived.srcVocabSrc
      dstSrc = dstSrc ?? derived.dstVocabSrc
    }
  }

  if (!srcSrc || !dstSrc) {
    throw new ModelLoadFailedError(
      'Bergamot requires srcVocabSrc and dstVocabSrc. Provide them in modelConfig, or load a registry://, pear:// or local model file named model[.<pair>].intgemm.alphas.bin to use the vocab beside it.'
    )
  }

  if (!pivotModel) {
    const modelIsRegistry = ctx.modelSrc.startsWith('registry://')
    const vocabsAreDerived = !srcVocabSrc && !dstVocabSrc
    if (modelIsRegistry && vocabsAreDerived) {
      return { config: nmtConfig }
    }

    const [srcVocabPath, dstVocabPath] = await Promise.all([
      ctx.resolveModelPath(srcSrc),
      ctx.resolveModelPath(dstSrc)
    ])
    return {
      config: nmtConfig,
      artifacts: { srcVocabPath, dstVocabPath }
    }
  }

  let pivotSrcSrc: ModelSrcInput | undefined = pivotModel.srcVocabSrc
  let pivotDstSrc: ModelSrcInput | undefined = pivotModel.dstVocabSrc

  if (!pivotSrcSrc || !pivotDstSrc) {
    const pivotDerived = deriveBergamotVocabSourcesFor(pivotModel.modelSrc)
    if (pivotDerived) {
      pivotSrcSrc = pivotSrcSrc ?? pivotDerived.srcVocabSrc
      pivotDstSrc = pivotDstSrc ?? pivotDerived.dstVocabSrc
    }
  }

  if (!pivotSrcSrc || !pivotDstSrc) {
    throw new ModelLoadFailedError(
      'Bergamot pivot model requires srcVocabSrc and dstVocabSrc. Provide them in modelConfig, or load a registry://, pear:// or local model file named model[.<pair>].intgemm.alphas.bin to use the vocab beside it.'
    )
  }

  const modelIsRegistry = ctx.modelSrc.startsWith('registry://')
  const pivotIsRegistry = pivotModel.modelSrc.startsWith('registry://')
  const primaryVocabsAreDerived = !srcVocabSrc && !dstVocabSrc
  const pivotVocabsAreDerived = !pivotModel.srcVocabSrc && !pivotModel.dstVocabSrc
  if (modelIsRegistry && pivotIsRegistry && primaryVocabsAreDerived && pivotVocabsAreDerived) {
    const pivotModelPath = await ctx.resolveModelPath(pivotModel.modelSrc)
    return { config: nmtConfig, artifacts: { pivotModelPath } }
  }

  const [srcVocabPath, dstVocabPath, pivotSrcVocabPath, pivotDstVocabPath, pivotModelPath] =
    await Promise.all([
      ctx.resolveModelPath(srcSrc),
      ctx.resolveModelPath(dstSrc),
      ctx.resolveModelPath(pivotSrcSrc),
      ctx.resolveModelPath(pivotDstSrc),
      ctx.resolveModelPath(pivotModel.modelSrc)
    ])

  return {
    config: nmtConfig,
    artifacts: {
      srcVocabPath,
      dstVocabPath,
      pivotSrcVocabPath,
      pivotDstVocabPath,
      pivotModelPath
    }
  }
}
