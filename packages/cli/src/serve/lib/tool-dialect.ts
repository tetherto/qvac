import { getLoadedModelInfo, type ToolDialect } from '@qvac/sdk'

// Resolved dialect drives native tool-call replay — see synthesizeToolCallContent.
// A loaded model's dialect never changes, so cache it once per SDK model id.
const dialectCache = new Map<string, ToolDialect>()

export async function resolveToolDialect(sdkModelId: string): Promise<ToolDialect> {
  const cached = dialectCache.get(sdkModelId)
  if (cached !== undefined) {
    return cached
  }

  try {
    const info = await getLoadedModelInfo({ modelId: sdkModelId })
    if (!info.isDelegated && info.toolDialect !== undefined) {
      // Only cache a real resolution: caching the fallback would pin the model
      // to hermes for the process even after a transient RPC failure recovers,
      // re-leaking markup for a native-dialect model on every later turn.
      dialectCache.set(sdkModelId, info.toolDialect)
      return info.toolDialect
    }
  } catch {
    // Leave uncached so a later turn can retry once the model is resolvable.
  }

  return 'hermes'
}
