import { createStreamLogger, registerAddonLogger } from '@/logging'
import type { ModelType } from '@/schemas'

type AsrModelType =
  typeof ModelType.whispercppTranscription | typeof ModelType.parakeetTranscription

/**
 * ASRGgml's native logger is process-global and cannot identify its originating
 * model. Keep instance loggers on engine-specific namespaces so the logger
 * passed to each ASRGgml instance remains isolated instead of subscribing both
 * model streams to the shared native callback.
 */
export function createAsrModelLogger(modelId: string, modelType: AsrModelType) {
  const logger = createStreamLogger(modelId, modelType)
  registerAddonLogger(modelId, modelType, logger)
  return logger
}
