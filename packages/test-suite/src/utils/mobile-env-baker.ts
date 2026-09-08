import type { QvacTestConfig } from '../types/config.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Resolve environment variable value from config
 */
function resolveEnvValue(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }

  // The guard above already excludes null, so `typeof value === 'object'` is
  // enough to make `'env' in value` safe here.
  if (typeof value === 'object' && 'env' in value) {
    const envVar = (value as { env: string }).env
    return process.env[envVar] || ''
  }

  return String(value)
}

/**
 * Recursively walk config object and convert to EXPO_PUBLIC_ env vars
 * Special handling: broker.* fields are flattened to mqtt.* level
 */
function processConfigToEnv(
  obj: unknown,
  prefix: string = 'EXPO_PUBLIC_MQTT',
  parentKey: string = ''
): Record<string, string> {
  const result: Record<string, string> = {}

  if (!obj || typeof obj !== 'object') {
    return result
  }

  for (const [key, value] of Object.entries(obj)) {
    // Flatten broker.* to mqtt.* level (skip adding BROKER to key name)
    const shouldFlatten = parentKey === '' && key === 'broker'
    const envKey = shouldFlatten ? prefix : `${prefix}_${key.toUpperCase()}`

    if (value && typeof value === 'object' && !('env' in value)) {
      // Nested object - recurse
      Object.assign(result, processConfigToEnv(value, envKey, key))
    } else {
      // Leaf value - resolve and add
      const resolved = resolveEnvValue(value)
      if (resolved) {
        result[envKey] = resolved
      }
    }
  }

  return result
}

/**
 * Generate .env file for mobile consumer with EXPO_PUBLIC_ prefixed variables
 * Expo will bake these into the bundle at build time
 */
export function generateMobileEnvFile(
  config: QvacTestConfig,
  runId: string,
  configDir?: string
): string {
  if (!config.mqtt) {
    throw new Error('MQTT configuration is required for mobile consumers')
  }

  const envLines = [
    '# Auto-generated environment config for mobile consumer',
    '# These variables are baked into the bundle at build time',
    ''
  ]

  // Process entire MQTT config tree automatically
  const mqttEnvVars = processConfigToEnv(config.mqtt)

  // Special handling for CA certificate - inline the content instead of path
  if (mqttEnvVars.EXPO_PUBLIC_MQTT_CAPATH) {
    const caPath = mqttEnvVars.EXPO_PUBLIC_MQTT_CAPATH
    const resolvedPath = configDir ? path.resolve(configDir, caPath) : path.resolve(caPath)

    if (fs.existsSync(resolvedPath)) {
      const caCertContent = fs.readFileSync(resolvedPath, 'utf-8')
      // Remove the path variable and add the content instead
      delete mqttEnvVars.EXPO_PUBLIC_MQTT_CAPATH
      // Escape newlines for .env format
      mqttEnvVars.EXPO_PUBLIC_MQTT_CA_CERT = caCertContent.replace(/\n/g, '\\n')
      console.log(`✅ Inlined CA certificate from ${caPath} (${caCertContent.length} bytes)`)
    } else {
      console.warn(`⚠️  CA certificate not found at ${resolvedPath}, skipping`)
      delete mqttEnvVars.EXPO_PUBLIC_MQTT_CAPATH
    }
  }

  // Add all resolved MQTT vars
  for (const [key, value] of Object.entries(mqttEnvVars)) {
    envLines.push(`${key}=${value}`)
  }

  // Add runId
  envLines.push(`EXPO_PUBLIC_RUN_ID=${runId}`)
  envLines.push('')

  return envLines.join('\n')
}
