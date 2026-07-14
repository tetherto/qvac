import type { ModelConstant } from '@/models/registry'
import * as registry from '@/models/registry'

function isModelConstant(value: unknown): value is ModelConstant {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as ModelConstant).src === 'string'
  )
}

/**
 * JSON export of every named model constant in `@/models/registry`
 * (`QWEN3_600M_INST_Q4`, `BCI_EMBEDDER`, ...) — the same constants JS
 * consumers import directly and pass as `modelSrc`
 * (`loadModel({ modelSrc: QWEN3_600M_INST_Q4, ... })`). Only the ~440
 * promoted-to-a-named-export entries are included, not the full ~780-entry
 * `models` array — entries without a name aren't meant for direct import in
 * JS either.
 *
 * This is a separate artifact from schema.json/manifest.json: it's a static
 * data catalog, not part of the RPC wire contract, but it lives alongside
 * them in contract/ for the same reason — a language-neutral build artifact
 * downstream client generators (starting with Python) consume.
 */
export function buildModelsRegistry(): Record<string, ModelConstant> {
  const namespace = registry as Record<string, unknown>
  const entries = Object.entries(namespace).filter(function (entry): entry is [
    string,
    ModelConstant
  ] {
    return isModelConstant(entry[1])
  })
  entries.sort(function (a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })
  return Object.fromEntries(entries)
}
