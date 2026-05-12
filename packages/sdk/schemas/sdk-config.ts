import { z } from "zod";
import { logLevelSchema } from "./logging-stream";
import { ModelType } from "./model-types";
import { llmConfigBaseSchema, embedConfigBaseSchema } from "./llamacpp-config";
import {
  whisperConfigSchema,
  parakeetConfigSchema,
} from "./transcription-config";
import { ocrConfigSchema } from "./ocr";
import { sdcppConfigSchema } from "./sdcpp-config";
import { runtimeContextSchema } from "./runtime-context";

// Alias keys for user convenience (maps to canonical types)
const AliasKeys = {
  llm: "llm",
  whisper: "whisper",
  embeddings: "embeddings",
  nmt: "nmt",
  parakeet: "parakeet",
  tts: "tts",
  ocr: "ocr",
  diffusion: "diffusion",
} as const;

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
  deviceModelContains: z.string().optional(),
});

export type DeviceMatch = z.infer<typeof deviceMatchSchema>;

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
    [ModelType.whispercppTranscription]: whisperConfigSchema
      .partial()
      .optional(),
    [ModelType.parakeetTranscription]: parakeetConfigSchema
      .partial()
      .optional(),
    [ModelType.nmtcppTranslation]: z.record(z.string(), z.unknown()).optional(),
    [ModelType.onnxTts]: z.record(z.string(), z.unknown()).optional(),
    [ModelType.onnxOcr]: ocrConfigSchema.partial().optional(),
    [ModelType.sdcppGeneration]: sdcppConfigSchema.partial().optional(),
    // Alias keys (user-friendly)
    [AliasKeys.llm]: llmConfigBaseSchema.optional(),
    [AliasKeys.embeddings]: embedConfigBaseSchema.optional(),
    [AliasKeys.whisper]: whisperConfigSchema.partial().optional(),
    [AliasKeys.parakeet]: parakeetConfigSchema.partial().optional(),
    [AliasKeys.nmt]: z.record(z.string(), z.unknown()).optional(),
    [AliasKeys.tts]: z.record(z.string(), z.unknown()).optional(),
    [AliasKeys.ocr]: ocrConfigSchema.partial().optional(),
    [AliasKeys.diffusion]: sdcppConfigSchema.partial().optional(),
  })
  .partial();

export type DeviceConfigDefaults = z.infer<typeof deviceConfigDefaultsSchema>;

/**
 * A device pattern rule for applying config defaults.
 */
export const devicePatternSchema = z.object({
  /** Human-readable name for this pattern (used in logs) */
  name: z.string(),
  /** Match criteria - all specified fields must match */
  match: deviceMatchSchema,
  /** Config defaults to apply when matched */
  defaults: deviceConfigDefaultsSchema,
});

export type DevicePattern = z.infer<typeof devicePatternSchema>;

const directoryPath = z.string().transform((s) => s.replace(/\/+$/, ""));

/**
 * QVAC SDK Configuration Schema
 *
 * This configuration is loaded once at SDK initialization from a config file
 * (qvac.config.json, qvac.config.js, or qvac.config.ts) and remains immutable
 * throughout the SDK's lifetime.
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
   * Global log level for all SDK loggers.
   * Options: "error", "warn", "info", "debug"
   * Defaults to "info".
   */
  loggerLevel: logLevelSchema.optional(),

  /**
   * Enable or disable console output for SDK loggers.
   * When false, logs are only sent to streams/transports, not printed to console.
   * Defaults to true.
   */
  loggerConsoleOutput: z.boolean().optional(),

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
   * Maximum number of retry attempts for registry (P2P) downloads on timeout.
   * When a download times out due to a P2P connection stall, the SDK will
   * automatically retry up to this many times before failing.
   * Defaults to 3.
   */
  registryDownloadMaxRetries: z.number().int().min(0).optional(),

  /**
   * Timeout in milliseconds for registry (P2P) download streams.
   * Controls how long the SDK will wait on a stalled Hypercore block before
   * triggering a REQUEST_TIMEOUT and (optionally) retrying. Raise this on
   * slow or high-latency connections where the default triggers spurious
   * retries / failures.
   * Defaults to 60000 (60 seconds).
   */
  registryStreamTimeoutMs: z.number().int().positive().optional(),

  /**
   * Device-specific config defaults.
   * Use this to override model config defaults for specific devices.
   * User-defined patterns are checked before SDK built-in patterns.
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
});

export type QvacConfig = z.infer<typeof qvacConfigSchema>;
