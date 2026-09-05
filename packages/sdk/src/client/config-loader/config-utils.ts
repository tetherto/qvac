import { qvacConfigSchema, type QvacConfig as InferenceQvacConfig } from '@qvac/inference/surface'
import { ConfigValidationFailedError } from '@/utils/errors-client'
import { formatZodError } from '@/utils/zod-error'
import { z } from 'zod'

/** Bundler-only fields kept compatible with older inference package installs. */
const bundlerConfigSchema = z.object({
  includeAudioDecoder: z.boolean().optional()
})

export type QvacConfig = InferenceQvacConfig & {
  includeAudioDecoder?: boolean
}

export function validateConfig(config: unknown): QvacConfig {
  const result = qvacConfigSchema.safeParse(config)

  if (!result.success) {
    throw new ConfigValidationFailedError(formatZodError(result.error))
  }

  const bundlerResult = bundlerConfigSchema.safeParse(config)
  if (!bundlerResult.success) {
    throw new ConfigValidationFailedError(formatZodError(bundlerResult.error))
  }

  return {
    ...result.data,
    ...(bundlerResult.data.includeAudioDecoder !== undefined && {
      includeAudioDecoder: bundlerResult.data.includeAudioDecoder
    })
  }
}

export function parseJsonConfig(content: string, filePath: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    throw new ConfigValidationFailedError(`Invalid JSON in config file: ${filePath}`)
  }
}
