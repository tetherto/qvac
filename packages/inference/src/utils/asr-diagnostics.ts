import { graphicsDriverSchema, ASR_BACKEND_IDS } from '@/schemas/index'
import type { InferenceBackendDiagnostics, TranscribeStats } from '@/schemas/index'

/**
 * Backend name for a numeric `backendId`, lowercased to match the shared
 * `graphicsDriverSchema` vocabulary. `Other` has no name a caller could act
 * on, so it resolves to `undefined` rather than a guess.
 */
function asrBackendName(backendId: number | undefined): string | undefined {
  if (backendId === undefined) return undefined
  for (const [name, id] of Object.entries(ASR_BACKEND_IDS)) {
    if (id === backendId && name !== 'Other') return name.toLowerCase()
  }
  return undefined
}

/**
 * Map the whisper.cpp-family backend stats onto the shared diagnostics shape,
 * the same way the audiogen op does. Shared by the `@qvac/asr-ggml` engines
 * and `@qvac/bci-whispercpp`. `backendDevice` is the addon's own verdict:
 * `1` means it ran on the GPU, anything else means CPU.
 *
 * The engines report no fallback reason, so `fallback` is never populated —
 * unlike audiogen, a CPU run here is indistinguishable from one that never
 * asked for a GPU.
 */
export function buildAsrBackendDiagnostics(
  stats: TranscribeStats | undefined
): InferenceBackendDiagnostics | undefined {
  if (!stats || stats.backendDevice === undefined) return undefined
  if (stats.backendDevice !== 1) {
    return { selectedBackend: 'cpu', selectedDevice: 'cpu' }
  }

  // A 'cpu' name against backendDevice 1 is the addon contradicting itself.
  const selectedBackend = asrBackendName(stats.backendId)
  if (selectedBackend === undefined || selectedBackend === 'cpu') return undefined

  const graphicsApi = graphicsDriverSchema.safeParse(selectedBackend)
  return {
    selectedBackend,
    selectedDevice: 'gpu',
    ...(graphicsApi.success && { graphicsApi: graphicsApi.data })
  }
}
