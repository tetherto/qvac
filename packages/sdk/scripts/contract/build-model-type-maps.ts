import { ModelTypeAliases } from '@/schemas/model-types'
import { ENGINE_TO_ADDON, LEGACY_ENGINE_TO_CANONICAL } from '@/schemas/engine-addon-map'

/**
 * JSON export of the model-type resolution maps that `loadModel`'s
 * client-side type-inference reads: alias → canonical model type, canonical
 * engine → addon, and legacy engine string → canonical engine.
 *
 * Inference itself stays in each client (a plain string `modelSrc` carries no
 * engine to infer from, so it can't move server-side), but the *data* it reads
 * must not drift between languages — so the maps are exported here, alongside
 * schema.json/models.json, and generated into each client rather than
 * hand-copied. `contract:check` (JS) and `generate.py --check` (Python) then
 * fail the build if a map is edited on one side only.
 *
 * A separate artifact from schema.json for the same reason models.json is: a
 * language-neutral data catalog, not part of the RPC wire contract.
 */
export interface ModelTypeMaps {
  aliasToCanonical: Record<string, string>
  engineToAddon: Record<string, string>
  legacyEngineToCanonical: Record<string, string>
}

function sortedEntries(record: Record<string, string>): Record<string, string> {
  const entries = Object.entries(record)
  entries.sort(function (a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })
  return Object.fromEntries(entries)
}

export function buildModelTypeMaps(): ModelTypeMaps {
  return {
    aliasToCanonical: sortedEntries(ModelTypeAliases),
    engineToAddon: sortedEntries(ENGINE_TO_ADDON),
    legacyEngineToCanonical: sortedEntries(LEGACY_ENGINE_TO_CANONICAL)
  }
}
