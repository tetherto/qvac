import {
  defineConfigKey,
  getConfigSnapshot,
  installConfig,
  resolveConfig,
  type ConfigSnapshot,
  type ConfigValue
} from '@qvac/config'
import type { LogLevel } from '@qvac/logging'

const loggingLevelKey = defineConfigKey({
  name: 'logging.level',
  env: ['QVAC_LOG_LEVEL', 'EXPO_PUBLIC_QVAC_LOG_LEVEL'],
  default: 'info',
  parse: parseLogLevel
})

export function resolveAssistantConfig(
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

export function installAssistantConfig(
  logging?: { readonly level?: LogLevel }
) {
  const snapshot = resolveAssistantConfig(logging)
  installConfig(snapshot)
  return snapshot
}

export function assistantLogLevel(
  snapshot: ConfigSnapshot = getConfigSnapshot()
): LogLevel {
  return loggingLevelKey.parse(snapshot.values[loggingLevelKey.name] ?? 'info')
}

function parseLogLevel(value: ConfigValue): LogLevel {
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
