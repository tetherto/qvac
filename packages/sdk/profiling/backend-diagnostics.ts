import { BACKEND_DIAGNOSTICS_KEY, type InferenceBackendDiagnostics } from '@/schemas'

export function attachBackendDiagnostics<T>(
  target: T,
  diagnostics: InferenceBackendDiagnostics
): T {
  ;(target as unknown as Record<symbol, InferenceBackendDiagnostics>)[BACKEND_DIAGNOSTICS_KEY] =
    diagnostics
  return target
}
