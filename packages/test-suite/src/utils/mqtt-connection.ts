import mqtt, { type IClientOptions } from 'mqtt'
import { mqttConnectionSchema, type MqttConnectionConfig } from '../schemas/mqtt-config.js'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { buildMqttProtocolOptions, buildMqttSessionOptions } from './mqtt-session.js'

export type { MqttConnectionConfig } from '../schemas/mqtt-config.js'

function resolveEnvValue(value: unknown): unknown {
  if (!value) return undefined
  // The truthiness guard above already excludes null, so `typeof value ===
  // 'object'` is enough to make `'env' in value` safe here.
  if (typeof value === 'object' && 'env' in value) {
    const envVar = (value as { env: string }).env
    const envValue = process.env[envVar]
    if (envValue && !isNaN(Number(envValue))) return Number(envValue)
    return envValue
  }
  return value
}

function resolveEnvReferences(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  if ('env' in obj) return resolveEnvValue(obj)

  const resolved: any = Array.isArray(obj) ? [] : {}
  for (const key in obj) {
    resolved[key] = resolveEnvReferences(obj[key])
  }
  return resolved
}

export function buildMqttConnectionConfig(config: any): MqttConnectionConfig {
  const resolved = resolveEnvReferences(config.mqtt || {})

  let brokerUrl = resolved.brokerUrl || process.env.MQTT_BROKER_URL

  if (!brokerUrl && resolved.broker) {
    const protocol = resolved.broker.protocol || 'mqtt'
    const host = resolved.broker.host
    const defaultPorts: Record<string, number> = { mqtt: 1883, mqtts: 8883, ws: 8080, wss: 8081 }
    const port = resolved.broker.port || defaultPorts[protocol] || 1883
    brokerUrl = `${protocol}://${host}:${port}`
  }

  return mqttConnectionSchema.parse({
    brokerUrl,
    username: resolved.username || process.env.MQTT_USERNAME,
    password: resolved.password || process.env.MQTT_PASSWORD,
    caPath: resolved.caPath || process.env.MQTT_CA_PATH,
    certPath: resolved.certPath || process.env.MQTT_CERT_PATH,
    keyPath: resolved.keyPath || process.env.MQTT_KEY_PATH,
    rejectUnauthorized: resolved.rejectUnauthorized,
    keepalive: resolved.keepalive,
    reconnectPeriod: resolved.reconnectPeriod,
    connectTimeout: resolved.connectTimeout,
    sessionExpiryInterval: resolved.sessionExpiryInterval
  })
}

export function buildMqttOptions(config: MqttConnectionConfig, configDir?: string): IClientOptions {
  const options: IClientOptions = {
    keepalive: config.keepalive ?? 30,
    reconnectPeriod: config.reconnectPeriod ?? 3000,
    connectTimeout: config.connectTimeout ?? 15000,
    ...buildMqttProtocolOptions(config.sessionExpiryInterval)
  }

  const username = config.username || process.env.MQTT_USERNAME
  const password = config.password || process.env.MQTT_PASSWORD

  if (username && password) {
    options.username = username
    options.password = password
  }

  const caPath = config.caPath || process.env.MQTT_CA_PATH
  const certPath = config.certPath || process.env.MQTT_CERT_PATH
  const keyPath = config.keyPath || process.env.MQTT_KEY_PATH

  // Helper to resolve paths relative to config directory
  const resolvePath = (filePath: string): string => {
    if (path.isAbsolute(filePath)) {
      return filePath
    }
    return configDir ? path.resolve(configDir, filePath) : path.resolve(filePath)
  }

  // Load certificates if paths are provided
  if (caPath) {
    const resolvedCaPath = resolvePath(caPath)
    if (fs.existsSync(resolvedCaPath)) {
      options.ca = fs.readFileSync(resolvedCaPath)
    } else {
      console.warn(`MQTT CA certificate not found at: ${resolvedCaPath}`)
    }
  }

  if (certPath) {
    const resolvedCertPath = resolvePath(certPath)
    if (fs.existsSync(resolvedCertPath)) {
      options.cert = fs.readFileSync(resolvedCertPath)
    } else {
      console.warn(`MQTT client certificate not found at: ${resolvedCertPath}`)
    }
  }

  if (keyPath) {
    const resolvedKeyPath = resolvePath(keyPath)
    if (fs.existsSync(resolvedKeyPath)) {
      options.key = fs.readFileSync(resolvedKeyPath)
    } else {
      console.warn(`MQTT client key not found at: ${resolvedKeyPath}`)
    }
  }

  if (config.rejectUnauthorized !== undefined) {
    options.rejectUnauthorized = config.rejectUnauthorized
  }

  return options
}

export function logMqttConnectionSecurity(brokerUrl: string, options: IClientOptions): void {
  const isTls = brokerUrl.startsWith('mqtts://') || brokerUrl.startsWith('wss://')
  const hasAuth = !!(options.username && options.password)
  const hasClientCert = !!(options.cert && options.key)
  const hasCaCert = !!options.ca

  console.log('🔐 MQTT Connection Security:')
  console.log(`   Broker: ${brokerUrl}`)
  console.log(`   TLS: ${isTls ? '✅' : '❌'}`)
  console.log(`   Username/Password: ${hasAuth ? '✅' : '❌'}`)
  console.log(`   CA Certificate (server verification): ${hasCaCert ? '✅' : '❌'}`)
  console.log(`   Client Certificate (mTLS): ${hasClientCert ? '✅' : '❌'}`)

  if (!isTls && !hasAuth && !hasClientCert) {
    console.log('⚠️  No authentication configured (local development mode)')
  }

  if (options.clientId) {
    console.log(`   Client ID: ${options.clientId}`)
    console.log(`   Clean session: ${options.clean ?? true}`)
  }

  console.log(
    `   Keepalive: ${options.keepalive ?? 60}s | Reconnect: ${options.reconnectPeriod ?? 1000}ms`
  )
  console.log('')
}

export interface CreateMqttClientOptions {
  clientId?: string
}

export function createMqttClient(
  config: MqttConnectionConfig,
  configDir?: string,
  opts?: CreateMqttClientOptions
) {
  const options = buildMqttOptions(config, configDir)

  if (opts?.clientId) {
    Object.assign(options, buildMqttSessionOptions(opts.clientId, config.sessionExpiryInterval))
  }

  logMqttConnectionSecurity(config.brokerUrl, options)
  return mqtt.connect(config.brokerUrl, options)
}
