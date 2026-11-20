import {
  LEGACY_MODEL_CONFIG_KEYS,
  LEGACY_REQUEST_KEYS,
  normalizeModelType,
  type CanonicalModelType,
  type LegacyKeySpec
} from '@qvac/inference/surface'

/**
 * JSON export of the request and model-config keys the worker still accepts
 * under their legacy spelling, keyed by the schema.json title of the object
 * that owns them: `{ [title]: { [legacyKey]: key } }`. Generated clients use
 * it to keep deprecated aliases that serialize under the legacy key, which the
 * worker renames with a deprecation warning.
 *
 * A separate artifact from schema.json, like models.json / error-codes.json.
 */
export type LegacyKeys = Record<string, Record<string, string>>

type JsonSchema = Record<string, unknown>

function isSchemaObject(node: unknown): node is JsonSchema {
  return node !== null && typeof node === 'object' && !Array.isArray(node)
}

function unionArmsOf(node: JsonSchema): unknown[] | undefined {
  if (Array.isArray(node['oneOf'])) return node['oneOf'] as unknown[]
  if (Array.isArray(node['anyOf'])) return node['anyOf'] as unknown[]
  return undefined
}

function record(out: LegacyKeys, title: unknown, renames: Record<string, string>) {
  if (typeof title !== 'string') {
    throw new Error(`Legacy keys [${Object.keys(renames).join(', ')}] sit on an untitled schema`)
  }
  const existing = out[title]
  if (existing && JSON.stringify(existing) !== JSON.stringify(renames)) {
    throw new Error(`Conflicting legacy keys for "${title}"`)
  }
  out[title] = renames
}

function collectSpec(node: unknown, spec: LegacyKeySpec, out: LegacyKeys): void {
  if (!isSchemaObject(node)) return
  const arms = unionArmsOf(node)
  if (arms) {
    for (const arm of arms) collectSpec(arm, spec, out)
    return
  }
  if (node['type'] === 'array') {
    collectSpec(node['items'], spec, out)
    return
  }
  const properties = node['properties']
  if (!isSchemaObject(properties)) return

  const renames: Record<string, string> = {}
  for (const [legacyKey, key] of Object.entries(spec.renames ?? {})) {
    if (key in properties && !(legacyKey in properties)) renames[legacyKey] = key
  }
  if (Object.keys(renames).length > 0) record(out, node['title'], sortedByKey(renames))

  for (const [key, childSpec] of Object.entries(spec.nested ?? {})) {
    collectSpec(properties[key], childSpec, out)
  }
}

function collectModelConfigs(node: unknown, out: LegacyKeys): void {
  if (!isSchemaObject(node)) return
  const arms = unionArmsOf(node)
  if (arms) {
    for (const arm of arms) collectModelConfigs(arm, out)
    return
  }
  const properties = node['properties']
  if (!isSchemaObject(properties)) return
  const canonical = canonicalModelTypeOf(properties['modelType'], node['title'])
  const spec = canonical && LEGACY_MODEL_CONFIG_KEYS[canonical]
  if (spec) collectSpec(properties['modelConfig'], spec, out)
}

/**
 * The one canonical model type a request arm names, as a `const` or as an
 * `enum` of a canonical type and its aliases, such as the reload request's
 * `["whisper", "whispercpp-transcription"]`.
 */
function canonicalModelTypeOf(modelType: unknown, title: unknown): CanonicalModelType | undefined {
  if (!isSchemaObject(modelType)) return undefined
  const values =
    typeof modelType['const'] === 'string'
      ? [modelType['const']]
      : Array.isArray(modelType['enum'])
        ? modelType['enum'].filter((value): value is string => typeof value === 'string')
        : []
  const canonical = new Set(values.map((value) => normalizeModelType(value)))
  if (canonical.size > 1) {
    throw new Error(
      `"${String(title)}" names more than one model type: ${[...canonical].join(', ')}`
    )
  }
  const [only] = canonical
  return only as CanonicalModelType | undefined
}

function sortedByKey<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(function (a, b) {
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    })
  )
}

export function buildLegacyKeys(defs: Readonly<Record<string, JsonSchema>>): LegacyKeys {
  const out: LegacyKeys = {}
  collectModelConfigs(defs['loadModel.request'], out)
  for (const [type, spec] of Object.entries(LEGACY_REQUEST_KEYS)) {
    const def = defs[`${type}.request`]
    if (!def) throw new Error(`LEGACY_REQUEST_KEYS names "${type}", which has no request schema`)
    collectSpec(def, spec, out)
  }
  return sortedByKey(out)
}
