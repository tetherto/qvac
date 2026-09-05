import { z } from 'zod'
import { logLevelSchema } from '@/schemas/logging-stream'
import { ModelType } from '@/schemas/model-types'
import { llmConfigBaseSchema, embedConfigBaseSchema } from '@/schemas/llamacpp-config'
import { whisperConfigSchema, parakeetConfigSchema } from '@/schemas/transcription-config'
import { ocrConfigSchema } from '@/schemas/ocr'
import { sdcppConfigSchema } from '@/schemas/sdcpp-config'
import { vlaConfigSchema } from '@/schemas/vla'
import { runtimeContextSchema } from '@/schemas/runtime-context'

// Alias keys for user convenience (maps to canonical types)
const AliasKeys = {
  llm: 'llm',
  whisper: 'whisper',
  embeddings: 'embeddings',
  nmt: 'nmt',
  parakeet: 'parakeet',
  tts: 'tts',
  ocr: 'ocr',
  diffusion: 'diffusion',
  vla: 'vla'
} as const

/**
 * Device match criteria for device-specific config defaults.
 * All specified criteria must match (AND logic).
 */
export const deviceMatchSchema = z.object({
  /** Platform to match: "android" or "ios" */
  platform: runtimeContextSchema.shape.platform,
  /** Device brand to match (case-insensitive exact match, e.g., "google", "samsung") */
  deviceBrand: z.string().optional(),
  /** Device model prefix to match (e.g., "Pixel 10" matches "Pixel 10 Pro") */
  deviceModelPrefix: z.string().optional(),
  /** Device model substring to match (e.g., "Galaxy" matches "Samsung Galaxy S25") */
  deviceModelContains: z.string().optional()
})

export type DeviceMatch = z.infer<typeof deviceMatchSchema>

/**
 * Device-specific model config defaults.
 * Accepts both canonical keys (e.g., "llamacpp-completion") and alias keys (e.g., "llm").
 * NMT and TTS use passthrough since they don't have device-relevant config.
 */
export const deviceConfigDefaultsSchema = z
  .object({
    // Canonical keys
    [ModelType.llamacppCompletion]: llmConfigBaseSchema.optional(),
    [ModelType.llamacppEmbedding]: embedConfigBaseSchema.optional(),
    [ModelType.whispercppTranscription]: whisperConfigSchema.partial().optional(),
    [ModelType.parakeetTranscription]: parakeetConfigSchema.partial().optional(),
    [ModelType.nmtcppTranslation]: z.record(z.string(), z.unknown()).optional(),
    [ModelType.ttsGgml]: z.record(z.string(), z.unknown()).optional(),
    [ModelType.ggmlOcr]: ocrConfigSchema.partial().optional(),
    [ModelType.sdcppGeneration]: sdcppConfigSchema.partial().optional(),
    [ModelType.ggmlVla]: vlaConfigSchema.partial().optional(),
    // Alias keys (user-friendly)
    [AliasKeys.llm]: llmConfigBaseSchema.optional(),
    [AliasKeys.embeddings]: embedConfigBaseSchema.optional(),
    [AliasKeys.whisper]: whisperConfigSchema.partial().optional(),
    [AliasKeys.parakeet]: parakeetConfigSchema.partial().optional(),
    [AliasKeys.nmt]: z.record(z.string(), z.unknown()).optional(),
    [AliasKeys.tts]: z.record(z.string(), z.unknown()).optional(),
    [AliasKeys.ocr]: ocrConfigSchema.partial().optional(),
    [AliasKeys.diffusion]: sdcppConfigSchema.partial().optional(),
    [AliasKeys.vla]: vlaConfigSchema.partial().optional()
  })
  .partial()

export type DeviceConfigDefaults = z.infer<typeof deviceConfigDefaultsSchema>

/**
 * A device pattern rule for applying config defaults.
 */
export const devicePatternSchema = z.object({
  /** Human-readable name for this pattern (used in logs) */
  name: z.string(),
  /** Match criteria - all specified fields must match */
  match: deviceMatchSchema,
  /** Config defaults to apply when matched */
  defaults: deviceConfigDefaultsSchema
})

export type DevicePattern = z.infer<typeof devicePatternSchema>

const directoryPath = z.string().transform((s) => s.replace(/\/+$/, ''))

/**
 * QVAC Configuration Schema
 *
 * This configuration is loaded once at initialization from a config file
 * (qvac.config.json, qvac.config.js, or qvac.config.ts) and remains immutable
 * throughout the process's lifetime.
 */
export const qvacConfigSchema = z.object({
  /**
   * Absolute path to the directory where models and other cached assets are stored.
   * If not specified, defaults to ~/.qvac/models
   */
  cacheDirectory: directoryPath.optional(),

  /**
   * Array of Hyperswarm relay public keys (hex strings) for improved P2P connectivity.
   * Blind relays help with NAT traversal and firewall bypassing.
   */
  swarmRelays: z.array(z.string()).optional(),

  /**
   * Global log level for all loggers.
   * Options: "error", "warn", "info", "debug", "off".
   * Defaults to "info".
   */
  loggerLevel: logLevelSchema.optional(),

  /**
   * Print logs to the console.
   * When false, logs still reach streams and transports but are not printed.
   * Defaults to false; set to true to see logs on the console.
   */
  loggerConsoleOutput: z.boolean().optional(),

  /**
   * Timeout in milliseconds for the worker RPC handshake performed when the SDK
   * initializes. Raise this on slow storage or embedded hardware where the first
   * worker start (native addon load) legitimately exceeds the default.
   * The `QVAC_RPC_INIT_TIMEOUT_MS` environment variable takes precedence.
   * Defaults to 30000 (30 seconds).
   */
  rpcInitTimeoutMs: z.number().int().positive().optional(),

  /**
   * Maximum number of concurrent HTTP downloads for sharded models.
   * Higher values may improve download speed but increase memory usage.
   * Defaults to 3.
   */
  httpDownloadConcurrency: z.number().int().positive().optional(),

  /**
   * Timeout in milliseconds for HTTP connection establishment.
   * This applies to HEAD and GET requests.
   * If the connection is not established within this time, the request fails.
   * Defaults to 10000 (10 seconds).
   */
  httpConnectionTimeoutMs: z.number().int().positive().optional(),

  /**
   * Require HTTP model downloads to be verified against a trusted checksum.
   * Sources that expose one (currently Hugging Face, via the Hub's SHA-256)
   * are always verified regardless of this flag, and a mismatch always fails.
   * This flag only governs the unverifiable cases:
   * - false (default): a source with no available checksum downloads with a
   *   warning (Hugging Face URLs that expose no SHA-256, and non-Hugging-Face
   *   URLs which have no checksum source).
   * - true: a source that should be verifiable but exposes no usable checksum
   *   (e.g. a Hugging Face URL without a SHA-256) is rejected; a source with no
   *   checksum source at all still downloads, with a warning that no checksum
   *   source was available.
   * Defaults to false.
   */
  requireHttpChecksum: z.boolean().optional(),

  /**
   * Enforce secure transport for HTTP model downloads: reject plaintext http://
   * and HTTPS->HTTP downgrade redirects (loopback exempt).
   * - false (default): enforced only for Hugging Face sources, whose Hub SHA-256
   *   attestation a downgrade could sidestep. Bring-your-own HTTP on any host,
   *   plaintext included, is left as-is.
   * - true: enforced for every HTTP source, so all downloads must use HTTPS.
   * Defaults to false.
   */
  requireSecureTransport: z.boolean().optional(),

  /**
   * Maximum number of retry attempts for registry (P2P) downloads on timeout.
   * When a download times out due to a P2P connection stall, we
   * automatically retry up to this many times before failing.
   * Defaults to 3.
   */
  registryDownloadMaxRetries: z.number().int().min(0).optional(),

  /**
   * Timeout in milliseconds for registry (P2P) download streams.
   * Controls how long we wait on a stalled Hypercore block before
   * triggering a REQUEST_TIMEOUT and (optionally) retrying. Raise this on
   * slow or high-latency connections where the default triggers spurious
   * retries / failures.
   * Defaults to 60000 (60 seconds).
   */
  registryStreamTimeoutMs: z.number().int().positive().optional(),

  /**
   * Device-specific config defaults.
   * Use this to override model config defaults for specific devices.
   * User-defined patterns are checked before the built-in patterns.
   * First matching pattern wins.
   *
   * @example
   * ```json
   * {
   *   "deviceDefaults": [
   *     {
   *       "name": "Custom Samsung",
   *       "match": { "platform": "android", "deviceBrand": "samsung" },
   *       "defaults": { "llm": { "device": "cpu" } }
   *     }
   *   ]
   * }
   * ```
   */
  deviceDefaults: z.array(devicePatternSchema).optional(),

  /**
   * Create new RAG workspaces on the TurboVec index instead of HyperDB.
   * The choice is per workspace and one-way: a workspace records its adapter
   * on first open and keeps it regardless of later config changes. The only
   * way to move an existing workspace back is `deleteWorkspace`, which
   * deletes its data.
   * Defaults to false.
   */
  ragTurbovec: z.boolean().optional(),

  /**
   * Inert: we do not read this field. Plugins are registered
   * in code with `registerPlugin` / `plugins([...])`, and there are no
   * defaults — nothing is registered until you register it. Carried over
   * from the bundle-time config schema; each entry is a plugin specifier
   * ending in `/plugin`.
   */
  plugins: z.array(z.string()).optional(),

  /**
   * Inert: we have no bundling or ABI-verification step, so this field is
   * unused. Carried over from the bundle-time config schema.
   */
  bareRuntimeVersion: z.string().optional(),

  /**
   * Whether generated worker bundles include the optional FFmpeg-backed audio
   * decoder. Defaults to true so encoded file-path inputs keep working. Set
   * this to false only when the app uses raw PCM/base64 audio exclusively; the
   * bundler then defers @qvac/decoder-audio and its native dependency.
   */
  includeAudioDecoder: z.boolean().optional()
})

export type QvacConfig = z.infer<typeof qvacConfigSchema>
