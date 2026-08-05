import {
  defineConfigKey,
  deserializeConfig,
  getConfigSnapshot,
  getOptionalConfigSnapshot,
  installConfig,
  resolveConfig,
  serializeConfig,
  type ConfigSnapshot,
  type ConfigValue
} from '@qvac/config'
import type { LogLevel } from '@qvac/logging'
import type { HarnessLoggingConfig } from './types.ts'

const CONFIG_ARG_PREFIX = '--harness-config='
const loggingLevelKey = defineConfigKey({
  name: 'logging.level',
  env: ['QVAC_LOG_LEVEL', 'EXPO_PUBLIC_QVAC_LOG_LEVEL'],
  default: 'info',
  parse: parseLogLevel
})

export function resolveHarnessConfig(
  logging?: HarnessLoggingConfig,
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

export function configForHarnessRuntime(
  logging?: HarnessLoggingConfig,
  env?: Readonly<Record<string, string | undefined>>
) {
  const installed = getOptionalConfigSnapshot()
  if (!installed) return resolveHarnessConfig(logging, env)
  if (logging?.level) {
    installConfig(resolveHarnessConfig(logging, env))
  }
  return installed
}

export function configArgvForHarness(snapshot: ConfigSnapshot) {
  return [`${CONFIG_ARG_PREFIX}${serializeConfig(snapshot)}`]
}

export function harnessConfigFromArgv(argv: readonly string[]) {
  const argument = argv.find((value) => value.startsWith(CONFIG_ARG_PREFIX))
  if (!argument) throw new Error('Missing Harness configuration snapshot')
  return deserializeConfig(argument.slice(CONFIG_ARG_PREFIX.length))
}

export function installHarnessConfigFromArgv(argv: readonly string[]) {
  const snapshot = harnessConfigFromArgv(argv)
  installConfig(snapshot)
  return snapshot
}

export function harnessLogLevel(
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
