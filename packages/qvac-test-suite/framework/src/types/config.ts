import { z } from 'zod';

/**
 * Consumer platform configuration schema
 */
const consumerPlatformSchema = z.object({
  platforms: z
    .array(z.enum(['macos', 'windows', 'linux', 'ios', 'android']))
    .describe('Target platforms for this consumer type'),

  entry: z.string().describe('Entry point file for the consumer (e.g., ./tests/desktop/consumer.ts)'),

  include: z.array(z.string()).describe('Glob patterns for files to bundle (e.g., ["./src/**", "./tests/**"])'),

  dependencies: z
    .union([z.literal('auto'), z.record(z.string())])
    .optional()
    .describe('Dependencies to install: "auto" reads from package.json, or provide manual map of package@version'),
});

/**
 * MQTT broker configuration schema (separate host/port)
 */
const mqttBrokerSchema = z.object({
  protocol: z
    .union([z.enum(['mqtt', 'mqtts', 'ws', 'wss']), z.object({ env: z.string() })])
    .optional()
    .default('mqtt')
    .describe('MQTT protocol. Provide directly or { env: "VAR_NAME" }'),

  host: z
    .union([z.string(), z.object({ env: z.string() })])
    .describe('MQTT broker host. Provide directly or { env: "VAR_NAME" }'),

  port: z
    .union([z.number(), z.object({ env: z.string() })])
    .optional()
    .describe(
      'MQTT broker port. Provide directly or { env: "VAR_NAME" }. Defaults: mqtt=1883, mqtts=8883, ws=8080, wss=8081'
    ),
});

/**
 * Complete MQTT configuration schema (broker + auth + certs)
 */
const mqttConfigSchema = z.object({
  // Broker configuration - Option A: URL
  brokerUrl: z
    .union([z.string().url(), z.object({ env: z.string() })])
    .optional()
    .describe('MQTT broker URL. Provide URL directly or { env: "VAR_NAME" }. Alternative: use broker object'),

  // Broker configuration - Option B: Separate components
  broker: mqttBrokerSchema.optional().describe('MQTT broker configuration (host/port). Alternative to brokerUrl'),

  // Authentication
  username: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe('Username for MQTT authentication. Provide string directly or { env: "VAR_NAME" } to read from env'),

  password: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe('Password for MQTT authentication. Provide string directly or { env: "VAR_NAME" } to read from env'),

  // TLS Certificates
  caPath: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe('Path to CA certificate. Provide path directly or { env: "VAR_NAME" } to read from env'),

  certPath: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe('Path to client certificate. Provide path directly or { env: "VAR_NAME" } to read from env'),

  keyPath: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe('Path to client key. Provide path directly or { env: "VAR_NAME" } to read from env'),

  rejectUnauthorized: z
    .boolean()
    .optional()
    .default(true)
    .describe('Verify TLS certificates (default: true). Set to false to disable certificate validation (testing only)'),
});

/**
 * Main configuration schema for QVAC test suite
 */
export const qvacTestConfigSchema = z.object({
  mqtt: mqttConfigSchema
    .optional()
    .describe('MQTT broker and authentication configuration. All MQTT-related settings go here'),

  testDir: z.string().describe('Directory containing test definitions (e.g., "./tests")'),

  runIdStrategy: z
    .union([z.literal('auto'), z.literal('manual'), z.function()])
    .optional()
    .default('auto')
    .describe(
      'Run ID generation: "auto" generates repo-branch-commit-timestamp, "manual" requires --runId flag, or custom function'
    ),

  consumers: z
    .object({
      desktop: consumerPlatformSchema.optional().describe('Desktop consumer configuration for Node.js platforms'),

      mobile: consumerPlatformSchema.optional().describe('Mobile consumer configuration for React Native platforms'),
    })
    .refine((data) => data.desktop || data.mobile, {
      message: 'At least one consumer type (desktop or mobile) must be configured',
    })
    .describe('Consumer configuration per platform type'),

  comparison: z
    .object({
      baselineRef: z
        .string()
        .default('main')
        .describe('Branch, tag, or commit to use as baseline for comparison (e.g., "main", "dev", "v1.0.0")'),
    })
    .optional()
    .describe('Report comparison configuration'),
});

/**
 * Infer TypeScript type from schema
 */
export type QvacTestConfig = z.infer<typeof qvacTestConfigSchema>;

/**
 * Helper function to define config with type safety and validation
 */
export function defineConfig(config: QvacTestConfig): QvacTestConfig {
  // Validate at definition time (catches errors early)
  return qvacTestConfigSchema.parse(config);
}
