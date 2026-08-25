import { getEngineLogger } from '@/logging'
import {
  BACKEND_DIAGNOSTICS_KEY,
  inferenceBackendDiagnosticsSchema,
  type InferenceBackendDiagnostics
} from '@/schemas'

const logger = getEngineLogger()

/**
 * Attaches diagnostics to a unary addon result, a plugin model-factory result,
 * or the terminal chunk of a streaming addon result. Earlier stream chunks are not inspected.
 */
export function attachBackendDiagnostics<T extends object>(
  target: T,
  diagnostics: InferenceBackendDiagnostics
): T {
  const parsed = inferenceBackendDiagnosticsSchema.parse(diagnostics)
  ;(target as unknown as Record<symbol, InferenceBackendDiagnostics>)[BACKEND_DIAGNOSTICS_KEY] =
    parsed
  return target
}

export function forwardBackendDiagnostics<T extends object>(target: T, source: unknown): T {
  if (!source || typeof source !== 'object') return target

  const diagnostics = (source as Record<symbol, unknown>)[BACKEND_DIAGNOSTICS_KEY]
  if (diagnostics !== undefined) {
    ;(target as unknown as Record<symbol, unknown>)[BACKEND_DIAGNOSTICS_KEY] = diagnostics
  }
  return target
}

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
