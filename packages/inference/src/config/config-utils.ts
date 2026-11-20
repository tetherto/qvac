import { qvacConfigSchema, renameLegacyConfigKeys, type QvacConfig } from '@/schemas/index'
import { ConfigValidationFailedError } from '@/errors/index'
import { formatZodError } from '@/utils/zod-error'
import { warnLegacyKey } from '@/runtime/legacy-keys'

export type { QvacConfig }

export function validateConfig(config: unknown): QvacConfig {
  const result = qvacConfigSchema.safeParse(renameLegacyConfigKeys(config, warnLegacyKey))

  if (!result.success) {
    throw new ConfigValidationFailedError(formatZodError(result.error))
  }

  return result.data
}

export function parseJsonConfig(content: string, filePath: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    throw new ConfigValidationFailedError(`Invalid JSON in config file: ${filePath}`)
  }
}
