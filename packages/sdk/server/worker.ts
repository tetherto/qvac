import process from "bare-process";
import { isBareKit } from "which-runtime";
import {
  createBareKitRPCServer,
  createIPCClient,
} from "@/server/rpc/create-server";
import { z } from "zod";
import { destroySwarm } from "@/server/bare/hyperswarm";
import { closeAllRagInstances } from "@/server/bare/rag-hyperdb";
import { cleanupDownloads } from "@/server/rpc/handlers/load-model/download-manager";
import { unloadAllModels } from "@/server/bare/registry/model-registry";
import {
  clearAllLoggingStreams,
  startLogBuffering,
} from "@/server/bare/registry/logging-stream-registry";
import {
  ADDON_NAMESPACES,
  createAddonLoggerCallback,
  clearAllAddonLoggers,
  getServerLogger,
  SDK_LOG_ID,
} from "@/logging";
import llmAddonLogging from "@qvac/llm-llamacpp/addonLogging";
import embedAddonLogging from "@qvac/embed-llamacpp/addonLogging";
import ttsAddonLogging from "@qvac/tts-onnx/addonLogging";
import whisperAddonLogging from "@qvac/transcription-whispercpp/addonLogging";
import nmtAddonLogging from "@qvac/translation-nmtcpp/addonLogging";

// Buffer SDK logs from startup so clients can receive them when they subscribe
startLogBuffering(SDK_LOG_ID);

const logger = getServerLogger();

logger.info("🐻 Hello from Bare");
logger.debug("Arguments to worker:", process.argv);

// Initialize addon logger callbacks
llmAddonLogging.setLogger(
  createAddonLoggerCallback(ADDON_NAMESPACES.LLAMACPP_LLM),
);
embedAddonLogging.setLogger(
  createAddonLoggerCallback(ADDON_NAMESPACES.LLAMACPP_EMBED),
);
ttsAddonLogging.setLogger(createAddonLoggerCallback(ADDON_NAMESPACES.TTS));
whisperAddonLogging.setLogger(
  createAddonLoggerCallback(ADDON_NAMESPACES.WHISPERCPP),
);
nmtAddonLogging.setLogger(createAddonLoggerCallback(ADDON_NAMESPACES.NMTCPP));

const defaultHomeDir =
  process.env["HOME"] || process.env["USERPROFILE"] || "/tmp";
let envConfig = { HOME_DIR: defaultHomeDir };
let hasRPCConfig = false;

if (isBareKit && process.argv[0]) {
  logger.info("Running in BareKit mode");
  envConfig["HOME_DIR"] = process.argv[0];
}

// Try to parse any argument as JSON config (fail gracefully)
if (process.argv[2]) {
  try {
    const rpcArgs = JSON.parse(process.argv[2]) as Partial<typeof envConfig>;
    envConfig = { ...envConfig, ...rpcArgs };
    hasRPCConfig = true;
    logger.info("Parsed RPC configuration from arguments");
  } catch {
    // Not JSON or invalid - use defaults (direct mode)
    logger.info("Using default configuration (direct mode)");
  }
}

const validatedEnv = z
  .object({
    QVAC_IPC_SOCKET_PATH: z.string().optional(),
    HOME_DIR: z.string(),
  })
  .parse(envConfig);

export function getEnv() {
  return {
    ...process.env,
    ...validatedEnv,
  };
}

let rpcInitialized = false;
export function ensureRPCSetup() {
  if (rpcInitialized) return;

  try {
    const ipcSocketPath = validatedEnv.QVAC_IPC_SOCKET_PATH;

    if (ipcSocketPath) {
      logger.info(
        `Running in desktop mode, connecting to IPC socket: ${ipcSocketPath}`,
      );
      // Connect to the IPC server (Named Pipe or Unix Socket)
      const rpc = createIPCClient(ipcSocketPath);
      logger.debug("Desktop IPC client created?", !!rpc);
    } else {
      logger.info("Running in BareKit IPC mode");
      // Start the standard RPC server with BareKit IPC for mobile
      createBareKitRPCServer();
    }
    logger.info("Bare worker started and listening for RPC requests");
    logger.debug("Working directory:", process.cwd());
    rpcInitialized = true;
  } catch (error) {
    logger.error("Worker error:", error);
    process.exit(1);
  }
}

// Auto-setup RPC only if we successfully parsed RPC configuration
if (hasRPCConfig) {
  ensureRPCSetup();
} else {
  logger.info("Running in direct mode - RPC setup will be lazy");
}

// Centralized logger cleanup
function clearLoggers() {
  clearAllLoggingStreams();
  clearAllAddonLoggers();
  llmAddonLogging.releaseLogger();
  embedAddonLogging.releaseLogger();
  ttsAddonLogging.releaseLogger();
  whisperAddonLogging.releaseLogger();
  nmtAddonLogging.releaseLogger();
}

// Centralized cleanup for graceful shutdown
let isShuttingDown = false;

async function shutdownHandler() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info("🐻 Bare worker shutdown signal received, cleaning up...");

  try {
    clearLoggers();
    await Promise.allSettled([
      destroySwarm(),
      closeAllRagInstances(),
      cleanupDownloads(),
      unloadAllModels(),
    ]);
    logger.info("✅ Cleanup completed successfully");
  } catch (error) {
    logger.error("❌ Error during shutdown cleanup:", error);
  }

  process.exit(0);
}

process.once("SIGTERM", () => void shutdownHandler());
process.once("SIGINT", () => void shutdownHandler());
