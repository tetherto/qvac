import { inferModelTypeFromModelSrc, ModelType, normalizeModelType } from '@qvac/inference/surface'
import { ModelSrcTypeMismatchError } from './errors-client'

/**
 * Throws {@link ModelSrcTypeMismatchError} when explicit
 * `modelType` disagrees with the type inferred from `modelSrc`.
 * Embedding descriptors may explicitly select decisions; the native
 * decision loader validates checkpoint compatibility.
 * No-op when nothing can be inferred.
 */
export function assertModelSrcMatchesModelType(modelSrc: unknown, explicitModelType: string): void {
  const inferred = inferModelTypeFromModelSrc(modelSrc)
  if (!inferred) return
  const normalizedInferred = normalizeModelType(inferred)
  const normalizedExplicit = normalizeModelType(explicitModelType)
  if (
    normalizedInferred === ModelType.llamacppEmbedding &&
    normalizedExplicit === ModelType.llamacppDecision
  ) {
    return
  }
  if (normalizedInferred !== normalizedExplicit) {
    throw new ModelSrcTypeMismatchError(normalizedInferred, normalizedExplicit)
  }
}
