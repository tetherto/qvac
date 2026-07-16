import { inferModelTypeFromModelSrc } from '../schemas/model-src-utils.ts'
import { normalizeModelType } from '../schemas/model-types.ts'
import { ModelSrcTypeMismatchError } from '../errors/index.ts'

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
