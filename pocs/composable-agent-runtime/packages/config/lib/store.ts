import {
  createConfigSnapshotFromEnvelope,
  serializeConfig
} from './snapshot.ts'
import type {
  ConfigKey,
  ConfigSnapshot,
  ConfigStore,
  ConfigValue
} from './types.ts'

export function createConfigStore(): ConfigStore {
  let installed: ConfigSnapshot | undefined
  let serialized: string | undefined

  function install(snapshot: ConfigSnapshot) {
    const normalized = createConfigSnapshotFromEnvelope(snapshot)
    const nextSerialized = serializeConfig(normalized)
    if (serialized !== undefined) {
      if (serialized === nextSerialized) return
      throw new Error(
        'Configuration is already installed with different values'
      )
    }
    installed = normalized
    serialized = nextSerialized
  }

  function snapshot() {
    if (!installed) throw new Error('Configuration is not installed')
    return installed
  }

  function optionalSnapshot() {
    return installed
  }

  function get<T extends ConfigValue>(key: ConfigKey<T>): T {
    const value = snapshot().values[key.name]
    if (value === undefined) {
      if (key.hasDefault && key.defaultValue !== undefined) {
        return key.parse(key.defaultValue)
      }
      throw new Error(`Configuration value is not installed: ${key.name}`)
    }
    return key.parse(value)
  }

  return { install, optionalSnapshot, snapshot, get }
}

const defaultStore = createConfigStore()

export function installConfig(snapshot: ConfigSnapshot) {
  defaultStore.install(snapshot)
}

export function getConfigSnapshot() {
  return defaultStore.snapshot()
}

export function getOptionalConfigSnapshot() {
  return defaultStore.optionalSnapshot()
}

export function getConfigValue<T extends ConfigValue>(key: ConfigKey<T>): T {
  return defaultStore.get(key)
}
