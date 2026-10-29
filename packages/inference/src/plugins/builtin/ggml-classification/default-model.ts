/** Default MobileNetV3-Small classifier, published in the model registry. */
export const DEFAULT_CLASSIFICATION_MODEL_SRC =
  'registry://s3/qvac_models_compiled/ggml/mobilenetv3-3class/2026-10-28/mobilenetv3_3class_v3_fp16.gguf'

/**
 * Classification may omit `modelSrc`. Fill the registry default unless the
 * caller already named a weights file via `modelConfig.modelPath`.
 */
export function classificationModelSrc(
  modelSrc: string | undefined,
  modelConfig: Record<string, unknown> | undefined
): string {
  const explicitPath = modelConfig?.['modelPath']
  const hasExplicitPath = typeof explicitPath === 'string' && explicitPath.length > 0
  if (!modelSrc && !hasExplicitPath) return DEFAULT_CLASSIFICATION_MODEL_SRC
  return modelSrc ?? ''
}
