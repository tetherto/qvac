import {
  defineConfigKey,
  deserializeConfig,
  getConfigSnapshot,
  getOptionalConfigSnapshot,
  installConfig,
  resolveConfig,
  serializeConfig,
  type ConfigSnapshot
} from '@qvac/config'
import type { LogLevel } from '@qvac/logging'

const loggingLevelKey = defineConfigKey({
  name: 'logging.level',
  env: ['QVAC_LOG_LEVEL', 'EXPO_PUBLIC_QVAC_LOG_LEVEL'],
  default: 'info',
  parse: parseLogLevel
})

export function resolveSyncConfig(
  logging?: { readonly level?: LogLevel },
  env?: Readonly<Record<string, string | undefined>>
) {
  return resolveConfig({
    keys: [loggingLevelKey],
    ...(logging?.level
      ? { values: { 'logging.level': logging.level } }
      : {}),
    ...(env ? { env } : {})
  })
}

export function configForSyncRuntime(
  logging?: { readonly level?: LogLevel },
  env?: Readonly<Record<string, string | undefined>>
) {
  const installed = getOptionalConfigSnapshot()
  if (!installed) return resolveSyncConfig(logging, env)
  if (logging?.level) {
    installConfig(resolveSyncConfig(logging, env))
  }
  return installed
}

export function installSyncConfig(encoded: string) {
  const snapshot = decodeSyncConfig(encoded)
  installConfig(snapshot)
  return snapshot
}

export function encodeSyncConfig(snapshot: ConfigSnapshot) {
  return serializeConfig(snapshot)
}

export function decodeSyncConfig(encoded: string) {
  return deserializeConfig(encoded)
}

export function syncLogLevel(
  snapshot: ConfigSnapshot = getConfigSnapshot()
): LogLevel {
  return loggingLevelKey.parse(snapshot.values[loggingLevelKey.name] ?? 'info')
}

function parseLogLevel(value: import('@qvac/config').ConfigValue): LogLevel {
  if (
    value === 'error' ||
    value === 'warn' ||
    value === 'info' ||
    value === 'debug' ||
    value === 'off'
  ) {
    return value
  }
  throw new Error('logging.level must be error, warn, info, debug, or off')
}
