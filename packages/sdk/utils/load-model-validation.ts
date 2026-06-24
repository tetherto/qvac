import { inferModelTypeFromModelSrc } from "@/schemas/model-src-utils";
import { normalizeModelType } from "@/schemas/model-types";
import { ModelSrcTypeMismatchError } from "./errors-client";

/** 
 * Throws {@link ModelSrcTypeMismatchError} when explicit 
 * `modelType` disagrees with the type inferred from `modelSrc`.
 * No-op when nothing can be inferred. 
 */
export function assertModelSrcMatchesModelType(
  modelSrc: unknown,
  explicitModelType: string,
): void {
  const inferred = inferModelTypeFromModelSrc(modelSrc);
  if (!inferred) return;
  const normalizedInferred = normalizeModelType(inferred);
  const normalizedExplicit = normalizeModelType(explicitModelType);
  if (normalizedInferred !== normalizedExplicit) {
    throw new ModelSrcTypeMismatchError(normalizedInferred, normalizedExplicit);
  }
}
