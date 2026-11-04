import path from 'bare-path'
import type { TranslationNmtcppConfig, TranslationNmtcppFiles } from '@qvac/translation-nmtcpp'

import { BERGAMOT_CJK_LANG_PAIRS, type NmtConfig } from '@/schemas/index'

/**
 * Derive absolute vocab paths from a resolved Bergamot model path.
 * Works for both companion-set layout (colocated files) and any layout where
 * vocab follows the standard naming convention beside the model binary.
 * Returns null if modelPath is not a recognisable Bergamot model.
 */
function deriveColocatedBergamotVocabPaths(modelPath: string) {
  const dirPath = path.dirname(modelPath)
  const basePath = path.basename(modelPath)
  const match = basePath.match(/^model\.([a-z]+)\.intgemm\.alphas\.bin$/)
  if (!match?.[1]) return null

  const langPair = match[1]
  if (BERGAMOT_CJK_LANG_PAIRS.includes(langPair)) {
    return {
      srcVocabPath: path.join(dirPath, `srcvocab.${langPair}.spm`),
      dstVocabPath: path.join(dirPath, `trgvocab.${langPair}.spm`)
    }
  }

  const sharedPath = path.join(dirPath, `vocab.${langPair}.spm`)
  return { srcVocabPath: sharedPath, dstVocabPath: sharedPath }
}

/** The files one translation load opens, shared by the load and its fit request. */
export function nmtFilesFor(
  modelPath: string,
  artifacts: Record<string, string>
): TranslationNmtcppFiles {
  const derived = deriveColocatedBergamotVocabPaths(modelPath)
  const srcVocabPath = artifacts['srcVocabPath'] ?? derived?.srcVocabPath
  const dstVocabPath = artifacts['dstVocabPath'] ?? derived?.dstVocabPath

  const pivotModelPath = artifacts['pivotModelPath']
  const pivotDerived = pivotModelPath ? deriveColocatedBergamotVocabPaths(pivotModelPath) : null
  const pivotSrcVocabPath = artifacts['pivotSrcVocabPath'] ?? pivotDerived?.srcVocabPath
  const pivotDstVocabPath = artifacts['pivotDstVocabPath'] ?? pivotDerived?.dstVocabPath

  return {
    model: modelPath,
    ...(srcVocabPath && { srcVocab: srcVocabPath }),
    ...(dstVocabPath && { dstVocab: dstVocabPath }),
    ...(pivotModelPath && { pivotModel: pivotModelPath }),
    ...(pivotSrcVocabPath && { pivotSrcVocab: pivotSrcVocabPath }),
    ...(pivotDstVocabPath && { pivotDstVocab: pivotDstVocabPath })
  }
}

/** The addon config for one translation load, shared with its fit request. */
export function nmtConfigFor(
  nmtConfig: NmtConfig,
  pivotModelPath?: string
): TranslationNmtcppConfig {
  const {
    engine,
    beamsize,
    lengthpenalty,
    maxlength,
    repetitionpenalty,
    norepeatngramsize,
    temperature,
    topk,
    topp
  } = nmtConfig

  return {
    modelType: engine,
    beamsize,
    lengthpenalty,
    maxlength,
    repetitionpenalty,
    norepeatngramsize,
    temperature,
    topk,
    topp,
    ...(nmtConfig.engine === 'Bergamot' && {
      ...(nmtConfig.normalize !== undefined && {
        normalize: nmtConfig.normalize
      }),
      ...(nmtConfig.pivotModel &&
        pivotModelPath && {
          pivotConfig: (() => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { modelSrc, dstVocabSrc, srcVocabSrc, ...pivotGenConfig } = nmtConfig.pivotModel
            return pivotGenConfig
          })()
        })
    })
  }
}
