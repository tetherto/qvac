import { getLoadedModelInfo, type ToolDialect } from '@qvac/sdk'

// A loaded model's tool dialect never changes, so resolve it once per SDK model
// id and reuse it. The value is the dialect the SDK completion normalizer will
// parse, so the server can replay a prior tool call in the same dialect the
// model natively emits.
const dialectCache = new Map<string, ToolDialect>()

export async function resolveToolDialect(sdkModelId: string): Promise<ToolDialect> {
  const cached = dialectCache.get(sdkModelId)
  if (cached !== undefined) {
    return cached
  }

  let dialect: ToolDialect = 'hermes'
  try {
    const info = await getLoadedModelInfo({ modelId: sdkModelId })
    if (!info.isDelegated && info.toolDialect !== undefined) {
      dialect = info.toolDialect
    }
  } catch {
    // Fall back to the Hermes envelope — the SDK parser's Hermes chain also
    // recovers most JSON-payload dialects, so an unresolved dialect degrades
    // gracefully rather than failing the request.
  }

  dialectCache.set(sdkModelId, dialect)
  return dialect
}
