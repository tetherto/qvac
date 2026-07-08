import type { CanonicalModelType } from '../schemas'
import { getConfig } from './config-registry'
import { getRuntimeContext } from './runtime-context-registry'
import { getEngineLogger } from '../logging'

export {
  CANONICAL_TO_ALIAS,
  MODEL_CONFIG_SCHEMAS,
  BUILTIN_DEVICE_PATTERNS,
  matchesPattern,
  findAllMatchingPatterns,
  getDefaultsFromPattern,
  resolveModelConfigWithContext
} from './model-config-utils'

import { BUILTIN_DEVICE_PATTERNS, resolveModelConfigWithContext } from './model-config-utils'

const logger = getEngineLogger()

export function resolveModelConfig<T>(
  modelType: CanonicalModelType,
  userInput: Record<string, unknown>
): T {
  const ctx = getRuntimeContext()
  const userPatterns = getConfig().deviceDefaults ?? []

  return resolveModelConfigWithContext<T>(
    modelType,
    userInput,
    ctx,
    userPatterns,
    BUILTIN_DEVICE_PATTERNS,
    (log) => {
      if (log.appliedPatterns.length > 0) {
        logger.debug(`[device-defaults] ${modelType}: applied [${log.appliedPatterns.join(' → ')}]`)
      }
    }
  )
}
