import { z } from "zod";
import { logLevelSchema } from "./logging-stream";

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
  cacheDirectory: z.string().optional(),

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
});

export type QvacConfig = z.infer<typeof qvacConfigSchema>;
