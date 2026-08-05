import type { ConfigSnapshot, ConfigValue } from './types.ts'

export const CONFIG_SNAPSHOT_VERSION = 1 as const

export function createConfigSnapshot(
  values: Readonly<Record<string, unknown>>
): ConfigSnapshot {
  const normalized: Record<string, ConfigValue> = {}
  for (const key of Object.keys(values).sort()) {
    assertNamespacedKey(key)
    const value = values[key]
    if (value === undefined) {
      throw new Error(`Configuration value is missing: ${key}`)
    }
    normalized[key] = normalizeConfigValue(value, key)
  }
  return Object.freeze({
    version: CONFIG_SNAPSHOT_VERSION,
    values: Object.freeze(normalized)
  })
}

export function serializeConfig(snapshot: ConfigSnapshot): string {
  return JSON.stringify(createConfigSnapshotFromEnvelope(snapshot))
}

export function deserializeConfig(encoded: string): ConfigSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch (cause) {
    throw new Error('Invalid configuration snapshot JSON', { cause })
  }
  return createConfigSnapshotFromEnvelope(parsed)
}

export function createConfigSnapshotFromEnvelope(
  envelope: unknown
): ConfigSnapshot {
  if (!isRecord(envelope)) {
    throw new Error('Configuration snapshot must be an object')
  }
  const version = Reflect.get(envelope, 'version')
  if (version !== CONFIG_SNAPSHOT_VERSION) {
    throw new Error(
      `Unsupported configuration snapshot version: ${String(version)}`
    )
  }
  const values = Reflect.get(envelope, 'values')
  if (!isRecord(values)) {
    throw new Error('Configuration snapshot values must be an object')
  }
  return createConfigSnapshot(values)
}

function normalizeConfigValue(value: unknown, path: string): ConfigValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Configuration number must be finite: ${path}`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item, index) =>
        normalizeConfigValue(item, `${path}[${index}]`)
      )
    )
  }
  if (!isRecord(value)) {
    throw new Error(`Configuration value must be JSON-safe: ${path}`)
  }
  const normalized: Record<string, ConfigValue> = {}
  for (const key of Object.keys(value).sort()) {
    const child = value[key]
    if (child === undefined) {
      throw new Error(`Configuration value is missing: ${path}.${key}`)
    }
    normalized[key] = normalizeConfigValue(child, `${path}.${key}`)
  }
  return Object.freeze(normalized)
}

function assertNamespacedKey(key: string) {
  if (
    !key.includes('.') ||
    key.startsWith('.') ||
    key.endsWith('.') ||
    key.includes('..')
  ) {
    throw new Error(`Configuration snapshot key must contain a namespace: ${key}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
