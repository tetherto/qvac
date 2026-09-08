import { z } from 'zod'

/**
 * Base consumer configuration (shared fields)
 */
const baseConsumerSchema = z.object({
  entry: z.string().describe('Entry point file for the consumer'),

  include: z
    .array(z.string())
    .describe('Glob patterns for files to bundle (e.g., ["./src/**", "./tests/**"])'),

  dependencies: z
    .union([z.literal('auto'), z.record(z.string())])
    .optional()
    .describe(
      'Dependencies to install: "auto" reads from package.json, or provide manual map of package@version'
    )
})

const packageManagerSchema = z.enum(['npm', 'bun', 'pnpm', 'yarn'])
const snapIdentifierSchema = z
  .string()
  .regex(
    /^(?=.*[a-z])[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
    'Snap identifiers must be 1-40 lowercase letters, numbers, or hyphens, include a letter, and start/end with a letter or number'
  )

const packagedConsumerSchema = baseConsumerSchema
  .omit({ include: true, dependencies: true })
  .extend({
    appDir: z.string().describe('Directory containing the packaged consumer application'),

    packageManager: packageManagerSchema
      .optional()
      .default('npm')
      .describe('Package manager used to install and package the application')
  })

/**
 * Desktop consumer configuration schema
 */
const desktopConsumerSchema = baseConsumerSchema.extend({
  platforms: z.array(z.enum(['macos', 'windows', 'linux'])).describe('Target desktop platforms')
})

/**
 * Electron consumer configuration schema
 */
const electronConsumerSchema = packagedConsumerSchema.extend({
  platforms: z
    .array(z.enum(['macos', 'windows', 'linux']))
    .describe('Target Electron desktop platforms'),

  appName: z
    .string()
    .optional()
    .describe(
      'Packaged Electron app executable/name. Defaults to package.json productName or name'
    ),

  outDir: z
    .string()
    .optional()
    .default('out')
    .describe('Electron Forge output directory relative to appDir'),

  packageScript: z
    .string()
    .optional()
    .default('package')
    .describe('package.json script that packages the Electron app')
})

/**
 * Snap consumer configuration schema
 */
export const snapConsumerSchema = packagedConsumerSchema.extend({
  runtime: z
    .literal('electron')
    .describe('Packaged application runtime; Snap consumers currently support Electron'),

  snapName: snapIdentifierSchema.describe(
    'Snap package name used for installation and mount paths'
  ),

  appCommand: snapIdentifierSchema.describe('App command declared under apps in snapcraft.yaml'),

  artifactPath: z.string().describe('Path to the built .snap artifact, relative to appDir'),

  snapConfigDir: z
    .string()
    .optional()
    .default('.')
    .describe('Config directory inside the mounted Snap, relative to its root'),

  packageScript: z
    .string()
    .optional()
    .default('package:snap')
    .describe('package.json script that builds the .snap artifact')
})

/**
 * Mobile consumer configuration schema
 */
const mobileConsumerSchema = baseConsumerSchema.extend({
  platforms: z.array(z.enum(['ios', 'android'])).describe('Target mobile platforms'),

  mobileInit: z
    .string()
    .optional()
    .describe(
      'Optional mobile initialization file (e.g., "./mobile-init.ts") for platform-specific setup'
    ),

  metroConfig: z
    .string()
    .optional()
    .describe(
      'Optional Metro config file (e.g., "./metro.config.js") to override default Metro configuration'
    ),

  assets: z
    .object({
      patterns: z
        .array(z.string())
        .describe(
          'Glob patterns for assets to bundle (e.g., ["./assets/audio/**/*", "./assets/documents/**/*"])'
        )
    })
    .optional()
    .describe('Asset bundling configuration'),

  expoPlugins: z
    .array(z.union([z.string(), z.tuple([z.string(), z.any()])]))
    .optional()
    .describe('Additional Expo plugins to include (e.g., ["@qvac/sdk/expo-plugin"])'),

  qvacConfig: z
    .string()
    .optional()
    .describe(
      'Path to a qvac.config.json file, copied into the mobile build output as qvac.config.json ' +
        'so SDK Expo plugins (e.g. withMobileBundle) can discover it during expo prebuild. ' +
        'Required to exist and must be a .json file when set.'
    ),

  copyArtifact: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to copy built APK/IPA to root of consumer directory (default: true)')
})

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

  path: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe(
      'MQTT broker path for WebSocket (e.g., "/mqtt"). Provide directly or { env: "VAR_NAME" }'
    )
})

/**
 * Complete MQTT configuration schema (broker + auth + certs)
 */
const mqttConfigSchema = z.object({
  // Broker configuration - Option A: URL
  brokerUrl: z
    .union([z.string().url(), z.object({ env: z.string() })])
    .optional()
    .describe(
      'MQTT broker URL. Provide URL directly or { env: "VAR_NAME" }. Alternative: use broker object'
    ),

  // Broker configuration - Option B: Separate components
  broker: mqttBrokerSchema
    .optional()
    .describe('MQTT broker configuration (host/port). Alternative to brokerUrl'),

  // Authentication
  username: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe(
      'Username for MQTT authentication. Provide string directly or { env: "VAR_NAME" } to read from env'
    ),

  password: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe(
      'Password for MQTT authentication. Provide string directly or { env: "VAR_NAME" } to read from env'
    ),

  // TLS Certificates
  caPath: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe(
      'Path to CA certificate. Provide path directly or { env: "VAR_NAME" } to read from env'
    ),

  certPath: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe(
      'Path to client certificate. Provide path directly or { env: "VAR_NAME" } to read from env'
    ),

  keyPath: z
    .union([z.string(), z.object({ env: z.string() })])
    .optional()
    .describe('Path to client key. Provide path directly or { env: "VAR_NAME" } to read from env'),

  rejectUnauthorized: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Verify TLS certificates (default: true). Set to false to disable certificate validation (testing only)'
    ),

  sessionExpiryInterval: z
    .union([z.number().int().min(1).max(0xfffffffe), z.object({ env: z.string() })])
    .optional()
    .describe(
      'MQTT 5 persistent-session expiry in seconds. Omit to retain MQTT 3.1.1 compatibility'
    )
})

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
      desktop: desktopConsumerSchema
        .optional()
        .describe('Desktop consumer configuration for Node.js platforms (macOS, Windows, Linux)'),

      mobile: mobileConsumerSchema
        .optional()
        .describe('Mobile consumer configuration for React Native platforms (iOS, Android)'),

      electron: electronConsumerSchema
        .optional()
        .describe('Electron consumer configuration for packaged Electron apps'),

      snap: snapConsumerSchema
        .optional()
        .describe('Snap consumer configuration for strict-confined Linux packages'),

      shared: z
        .object({
          include: z
            .array(z.string())
            .describe(
              'Glob patterns for shared code included in both desktop and mobile builds (e.g., ["./tests/shared/**"])'
            )
        })
        .optional()
        .describe('Shared code configuration included in both desktop and mobile consumer builds')
    })
    .refine((data) => data.desktop || data.mobile || data.electron || data.snap, {
      message: 'At least one consumer type (desktop, mobile, electron, or snap) must be configured'
    })
    .describe('Consumer configuration per platform type'),

  comparison: z
    .object({
      baselineRef: z
        .string()
        .default('main')
        .describe(
          'Branch, tag, or commit to use as baseline for comparison (e.g., "main", "dev", "v1.0.0")'
        )
    })
    .optional()
    .describe('Report comparison configuration')
})

/**
 * Infer TypeScript type from schema
 */
export type QvacTestConfig = z.infer<typeof qvacTestConfigSchema>

/**
 * Helper function to define config with type safety and validation
 */
export function defineConfig(config: QvacTestConfig): QvacTestConfig {
  // Validate at definition time (catches errors early)
  return qvacTestConfigSchema.parse(config)
}
