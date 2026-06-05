import { createHash } from 'node:crypto'

import type { SynthesizedServeConfig } from './config-synthesizer.js'

// A "fleet" is the set of sessions that can share one running serve. Two
// managed providers may reuse the same serve iff they would launch an
// identical one: same model set, same per-model config, same bind host. The
// fleet key is a stable hash of exactly those inputs, used to name the registry
// record so discovery is a single keyed lookup.
//
// Deliberately NOT part of the key: the port (auto-allocated), apiKey/headers
// (client-side only), and the ephemeral config path (per-spawn temp dir).
export function computeFleetKey (config: SynthesizedServeConfig, host: string): string {
  // Canonicalize: sort model aliases and their object keys so semantically
  // equal configs hash identically regardless of declaration order.
  const models = config.serve.models
  const canonical = Object.keys(models)
    .sort()
    .map((alias) => [alias, stableStringify(models[alias])] as const)

  const payload = JSON.stringify({ host, models: canonical })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

// JSON.stringify with object keys sorted recursively, so key order never
// perturbs the hash.
function stableStringify (value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const entries = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${entries.join(',')}}`
}
