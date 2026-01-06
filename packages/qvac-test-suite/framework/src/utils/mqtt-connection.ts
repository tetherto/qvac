import mqtt, { type IClientOptions } from 'mqtt';
import * as fs from 'node:fs';
import { mqttConnectionSchema, type MqttConnectionConfig } from '../schemas/mqtt-config.js';

export type { MqttConnectionConfig } from '../schemas/mqtt-config.js';

function resolveEnvValue(value: unknown): unknown {
  if (!value) return undefined;
  if (typeof value === 'object' && value !== null && 'env' in value) {
    const envVar = (value as { env: string }).env;
    const envValue = process.env[envVar];
    if (envValue && !isNaN(Number(envValue))) return Number(envValue);
    return envValue;
  }
  return value;
}

function resolveEnvReferences(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if ('env' in obj) return resolveEnvValue(obj);

  const resolved: any = Array.isArray(obj) ? [] : {};
  for (const key in obj) {
    resolved[key] = resolveEnvReferences(obj[key]);
  }
  return resolved;
}

export function buildMqttConnectionConfig(config: any): MqttConnectionConfig {
  const resolved = resolveEnvReferences(config.mqtt || {});

  let brokerUrl = resolved.brokerUrl || process.env.MQTT_BROKER_URL;

  if (!brokerUrl && resolved.broker) {
    const protocol = resolved.broker.protocol || 'mqtt';
    const host = resolved.broker.host;
    const defaultPorts: Record<string, number> = { mqtt: 1883, mqtts: 8883, ws: 8080, wss: 8081 };
    const port = resolved.broker.port || defaultPorts[protocol] || 1883;
    brokerUrl = `${protocol}://${host}:${port}`;
  }

  return mqttConnectionSchema.parse({
    brokerUrl,
    username: resolved.username || process.env.MQTT_USERNAME,
    password: resolved.password || process.env.MQTT_PASSWORD,
    caPath: resolved.caPath || process.env.MQTT_CA_PATH,
    certPath: resolved.certPath || process.env.MQTT_CERT_PATH,
    keyPath: resolved.keyPath || process.env.MQTT_KEY_PATH,
    rejectUnauthorized: resolved.rejectUnauthorized,
  });
}

export function buildMqttOptions(config: MqttConnectionConfig): IClientOptions {
  const options: IClientOptions = {};

  const username = config.username || process.env.MQTT_USERNAME;
  const password = config.password || process.env.MQTT_PASSWORD;

  if (username && password) {
    options.username = username;
    options.password = password;
  }

  const caPath = config.caPath || process.env.MQTT_CA_PATH;
  const certPath = config.certPath || process.env.MQTT_CERT_PATH;
  const keyPath = config.keyPath || process.env.MQTT_KEY_PATH;

  if (caPath && fs.existsSync(caPath)) {
    options.ca = fs.readFileSync(caPath);
  }

  if (certPath && fs.existsSync(certPath)) {
    options.cert = fs.readFileSync(certPath);
  }

  if (keyPath && fs.existsSync(keyPath)) {
    options.key = fs.readFileSync(keyPath);
  }

  if (config.rejectUnauthorized !== undefined) {
    options.rejectUnauthorized = config.rejectUnauthorized;
  }

  return options;
}

export function logMqttConnectionSecurity(brokerUrl: string, options: IClientOptions): void {
  const isTls = brokerUrl.startsWith('mqtts://') || brokerUrl.startsWith('wss://');
  const hasAuth = !!(options.username && options.password);
  const hasClientCert = !!(options.cert && options.key);
  const hasCaCert = !!options.ca;

  console.log('🔐 MQTT Connection Security:');
  console.log(`   Broker: ${brokerUrl}`);
  console.log(`   TLS: ${isTls ? '✅' : '❌'}`);
  console.log(`   Username/Password: ${hasAuth ? '✅' : '❌'}`);
  console.log(`   CA Certificate (server verification): ${hasCaCert ? '✅' : '❌'}`);
  console.log(`   Client Certificate (mTLS): ${hasClientCert ? '✅' : '❌'}`);

  if (!isTls && !hasAuth && !hasClientCert) {
    console.log('⚠️  No authentication configured (local development mode)');
  }

  console.log('');
}

export function createMqttClient(config: MqttConnectionConfig) {
  const options = buildMqttOptions(config);
  logMqttConnectionSecurity(config.brokerUrl, options);
  return mqtt.connect(config.brokerUrl, options);
}
