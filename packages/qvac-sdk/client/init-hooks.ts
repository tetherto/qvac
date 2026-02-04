import type { QvacConfig, RuntimeContext } from "@/schemas";
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

function applyClientLoggerSettings(config: QvacConfig) {
  if (config.loggerLevel !== undefined) {
    setGlobalLogLevel(config.loggerLevel);
  }
  if (config.loggerConsoleOutput !== undefined) {
    setGlobalConsoleOutput(config.loggerConsoleOutput);
  }
}

async function sendInitMessage(
  rpc: RPCClient,
  config: QvacConfig | undefined,
  runtimeContext: RuntimeContext | undefined,
) {
  const initMessage = {
    type: "__init_config",
    config,
    runtimeContext,
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
    throw new Error(parsed.error ?? "Unknown error");
  }
}

/**
 * Initializes SDK configuration and runtime context.
 * Config is loaded once and becomes immutable on the worker side.
 *
 * @param rpc - The RPC client instance
 * @param resolveConfig - Runtime-specific config resolver function
 * @param runtimeContext - Optional runtime context (platform, device info)
 */
export async function initializeConfig(
  rpc: RPCClient,
  resolveConfig: ResolveConfigFn,
  runtimeContext?: RuntimeContext,
) {
  const config = await resolveConfig();

  // Nothing to initialize
  if (!config && !runtimeContext) {
    return;
  }

  // Apply client-side logger settings
  if (config) {
    applyClientLoggerSettings(config);
    logger.info("📦 Initializing SDK config");
  }

  if (runtimeContext) {
    logger.info("📱 Runtime context:", runtimeContext);
  }

  try {
    await sendInitMessage(rpc, config, runtimeContext);
    logger.info("✅ Initialization complete");
  } catch (error) {
    logger.error("❌ Initialization failed:", error);
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
