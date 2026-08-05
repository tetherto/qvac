import runtimeEnv from '#env'
import { createConfigSnapshot } from './snapshot.ts'
import type {
  ConfigKey,
  ConfigSnapshot,
  ConfigValue,
  DefineConfigKeyOptions,
  ResolveConfigOptions
} from './types.ts'

export function defineConfigKey<T extends ConfigValue>(
  options: DefineConfigKeyOptions<T>
): ConfigKey<T> {
  assertKeyName(options.name)
  const env = Object.freeze([...(options.env ?? [])])
  if (new Set(env).size !== env.length) {
    throw new Error(`Configuration environment aliases must be unique: ${options.name}`)
  }
  if (env.some((name) => name.length === 0)) {
    throw new Error(`Configuration environment alias must not be empty: ${options.name}`)
  }
  const hasDefault = Object.prototype.hasOwnProperty.call(options, 'default')
  return Object.freeze({
    name: options.name,
    env,
    hasDefault,
    ...(hasDefault ? { defaultValue: options.default } : {}),
    parse: options.parse
  })
}

export function resolveConfig({
  keys,
  values = {},
  env = runtimeEnv
}: ResolveConfigOptions): ConfigSnapshot {
  const definitions = new Map<string, ConfigKey<ConfigValue>>()
  for (const key of keys) {
    if (definitions.has(key.name)) {
      throw new Error(`Duplicate configuration key: ${key.name}`)
    }
    definitions.set(key.name, key)
  }
  for (const name of Object.keys(values)) {
    if (!definitions.has(name)) {
      throw new Error(`Unknown configuration key: ${name}`)
    }
  }

  const resolved: Record<string, ConfigValue> = {}
  for (const key of keys) {
    const selected = selectValue(key, values, env)
    if (!selected.present) continue
    try {
      resolved[key.name] = key.parse(selected.value)
    } catch (cause) {
      if (cause instanceof Error) throw cause
      throw new Error(`Invalid configuration value: ${key.name}`, { cause })
    }
  }
  return createConfigSnapshot(resolved)
}

function selectValue(
  key: ConfigKey<ConfigValue>,
  values: Readonly<Record<string, ConfigValue>>,
  env: Readonly<Record<string, string | undefined>>
):
  | { readonly present: true; readonly value: ConfigValue }
  | { readonly present: false } {
  if (Object.prototype.hasOwnProperty.call(values, key.name)) {
    const value = values[key.name]
    if (value === undefined) {
      throw new Error(`Configuration value is missing: ${key.name}`)
    }
    return { present: true, value }
  }
  for (const name of key.env) {
    const value = env[name]
    if (value !== undefined && value.length > 0) {
      return { present: true, value }
    }
  }
  if (key.hasDefault) {
    const value = key.defaultValue
    if (value === undefined) {
      throw new Error(`Configuration default is missing: ${key.name}`)
    }
    return { present: true, value }
  }
  return { present: false }
}

function assertKeyName(name: string) {
  if (
    !name.includes('.') ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    name.includes('..')
  ) {
    throw new Error(`Configuration key must contain a namespace: ${name}`)
  }
}
