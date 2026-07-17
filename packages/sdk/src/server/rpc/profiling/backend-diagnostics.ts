import { getServerLogger } from '@/logging'
import {
  BACKEND_DIAGNOSTICS_KEY,
  inferenceBackendDiagnosticsSchema,
  type InferenceBackendDiagnostics
} from '@/schemas'

const logger = getServerLogger()

export function readBackendDiagnostics(target: unknown): InferenceBackendDiagnostics | undefined {
  if (!target || typeof target !== 'object') return undefined

  const diagnostics = (target as Record<symbol, unknown>)[BACKEND_DIAGNOSTICS_KEY]
  if (diagnostics === undefined) return undefined

  const result = inferenceBackendDiagnosticsSchema.safeParse(diagnostics)
  if (!result.success) {
    logger.debug('Ignoring invalid backend diagnostics', result.error)
    return undefined
  }

  return result.data
}
