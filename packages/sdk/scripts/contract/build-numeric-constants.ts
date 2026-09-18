import { ASR_BACKEND_IDS } from '@qvac/inference/surface'

/**
 * JSON export of the SDK's numeric public vocabularies (name → number).
 *
 * `constants-registry.ts` turns string vocabularies into named `$defs` enums,
 * but its `enumFromVocabulary` only takes strings, so a numeric vocabulary had
 * no way to reach the Python client — which then saw `backend_id` as a bare
 * number and had to hardcode `2 == CUDA`. This artifact carries them the same
 * way `error-codes.json` carries the numeric error registries, and
 * `sdk-python/scripts/generate.py` renders it into `_generated/numeric_constants.py`.
 *
 * A separate artifact from schema.json, like models.json / error-codes.json.
 */
export interface NumericConstants {
  ASR_BACKEND_IDS: Record<string, number>
}

function sortedByValue(record: Readonly<Record<string, number>>): Record<string, number> {
  const entries = Object.entries(record)
  entries.sort(function (a, b) {
    return a[1] - b[1]
  })
  return Object.fromEntries(entries)
}

export function buildNumericConstants(): NumericConstants {
  return {
    ASR_BACKEND_IDS: sortedByValue(ASR_BACKEND_IDS)
  }
}
