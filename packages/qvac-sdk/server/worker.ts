/**
 * Default worker entry point that registers ALL built-in plugins.
 */

import { initializeWorkerCore, ensureRPCSetup } from "@/server/worker-core";
import { registerPlugin } from "@/server/plugins";
import { getServerLogger } from "@/logging";
import {
  llmPlugin,
  embeddingsPlugin,
  whisperPlugin,
  nmtPlugin,
  ttsPlugin,
  ocrPlugin,
} from "@/server/bare/plugins";

const { hasRPCConfig } = initializeWorkerCore();

const logger = getServerLogger();

logger.info("🐻 Hello from Bare");

// Register all built-in plugins
registerPlugin(llmPlugin);
registerPlugin(embeddingsPlugin);
registerPlugin(whisperPlugin);
registerPlugin(nmtPlugin);
registerPlugin(ttsPlugin);
registerPlugin(ocrPlugin);

logger.info(
  hasRPCConfig
    ? "Parsed RPC configuration from arguments"
    : "Using default configuration (direct mode)",
);

// Auto-setup RPC only if we successfully parsed RPC configuration
if (hasRPCConfig) {
  ensureRPCSetup();
} else {
  logger.info("Running in direct mode - RPC setup will be lazy");
}
