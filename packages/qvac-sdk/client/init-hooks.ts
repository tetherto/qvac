import type { QvacConfig } from "@/schemas";
import {
  getClientLogger,
  setGlobalLogLevel,
  setGlobalConsoleOutput,
} from "@/logging";

const logger = getClientLogger();

type ResolveConfigFn = () => Promise<QvacConfig | undefined>;

// Minimal RPC interface for config initialization
// Using loose types to avoid Buffer type conflicts between Node/Bare runtimes
interface RPCClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request(command: number): any;
}

/**
 * Loads configuration from file and sends it to the worker during initialization.
 * Config is loaded once and becomes immutable on the worker side.
 *
 * @param rpc - The RPC client instance
 * @param resolveConfig - Runtime-specific config resolver function
 */
export async function initializeConfig(
  rpc: RPCClient,
  resolveConfig: ResolveConfigFn,
) {
  const config = await resolveConfig();

  if (!config) {
    // No config found - worker will use defaults
    return;
  }

  // Apply logger settings on client
  if (config.loggerLevel !== undefined) {
    setGlobalLogLevel(config.loggerLevel);
  }
  if (config.loggerConsoleOutput !== undefined) {
    setGlobalConsoleOutput(config.loggerConsoleOutput);
  }

  logger.info("📦 Initializing config:", config);

  try {
    // Send config to worker via internal init message
    // This bypasses the normal RPC flow since it's part of initialization
    const initMessage = {
      type: "__init_config",
      config,
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const req = rpc.request(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    req.send(JSON.stringify(initMessage), "utf8");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const response = await req.reply("utf8");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
    const parsed = JSON.parse(response.toString()) as {
      success: boolean;
      error?: string;
    };

    if (!parsed.success) {
      logger.error("❌ Failed to initialize config:", parsed.error);
    } else {
      logger.info("✅ Config successfully initialized");
    }
  } catch (error) {
    logger.error("❌ Error initializing config:", error);
  }
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use initializeConfig instead
 */
export function replayConfigIfCached() {
  logger.warn(
    "⚠️ replayConfigIfCached is deprecated and has no effect. Config is now loaded from file during initialization.",
  );
}
