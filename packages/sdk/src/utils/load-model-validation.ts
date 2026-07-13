import { inferModelTypeFromModelSrc } from '@qvac/core/surface'
import { normalizeModelType } from '@qvac/core/surface'
import { ModelSrcTypeMismatchError } from './errors-client'

/**
 * Throws {@link ModelSrcTypeMismatchError} when explicit
 * `modelType` disagrees with the type inferred from `modelSrc`.
 * No-op when nothing can be inferred.
 */
export function assertModelSrcMatchesModelType(modelSrc: unknown, explicitModelType: string): void {
  const inferred = inferModelTypeFromModelSrc(modelSrc)
  if (!inferred) return
  const normalizedInferred = normalizeModelType(inferred)
  const normalizedExplicit = normalizeModelType(explicitModelType)
  if (normalizedInferred !== normalizedExplicit) {
    throw new ModelSrcTypeMismatchError(normalizedInferred, normalizedExplicit)
  }
}
