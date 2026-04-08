import process from "bare-process";
import {
  createBareKitRPCServer,
  createIPCClient,
} from "@/server/rpc/create-server";
import { destroySwarm } from "@/server/bare/hyperswarm";
import { initEnv, getValidatedEnv } from "@/server/env";
import { closeAllRagInstances } from "@/server/bare/rag-hyperdb";
import { cleanupDownloads } from "@/server/rpc/handlers/load-model/download-manager";
import { unloadAllModels } from "@/server/bare/registry/model-registry";
import { closeRegistryClient } from "@/server/bare/registry/registry-client";
import {
  clearAllLoggingStreams,
  startLogBuffering,
} from "@/server/bare/registry/logging-stream-registry";
import { clearAllAddonLoggers, getServerLogger, SDK_LOG_ID } from "@/logging";
import { clearPlugins } from "@/server/plugins";

let coreInitialized = false;
let rpcInitialized = false;
let isShuttingDown = false;

const logger = getServerLogger();

export function initializeWorkerCore(): { hasRPCConfig: boolean } {
  if (coreInitialized) {
    const validatedEnv = getValidatedEnv();
    return { hasRPCConfig: !!validatedEnv.QVAC_IPC_SOCKET_PATH };
  }

  startLogBuffering(SDK_LOG_ID);

  const { hasRPCConfig } = initEnv();

  setupShutdownHandlers();

  coreInitialized = true;

  logger.debug("Worker core initialized");
  logger.debug("Arguments to worker:", process.argv);

  return { hasRPCConfig };
}

export function ensureRPCSetup() {
  if (rpcInitialized) return;

  if (!coreInitialized) {
    initializeWorkerCore();
  }

  try {
    const validatedEnv = getValidatedEnv();
    const ipcSocketPath = validatedEnv.QVAC_IPC_SOCKET_PATH;

    if (ipcSocketPath) {
      logger.info(
        `Running in desktop mode, connecting to IPC socket: ${ipcSocketPath}`,
      );
      const rpc = createIPCClient(ipcSocketPath);
      logger.debug("Desktop IPC client created?", !!rpc);
    } else {
      logger.info("Running in BareKit IPC mode");
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

export function isCoreInitialized(): boolean {
  return coreInitialized;
}
function clearRegistries() {
  clearAllLoggingStreams();
  clearAllAddonLoggers();
  clearPlugins();
}

export type BareDirectShutdownReason = "signal" | "rpc-close";

export async function shutdownBareDirectWorker(
  reason: BareDirectShutdownReason,
): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const message =
    reason === "signal"
      ? "🐻 Bare worker shutdown signal received, cleaning up..."
      : "🧹 Bare direct mode RPC closed, cleaning up...";
  logger.info(message);

  try {
    clearRegistries();
    await Promise.allSettled([
      destroySwarm(),
      closeAllRagInstances(),
      cleanupDownloads(),
      unloadAllModels(),
      closeRegistryClient(),
    ]);
    logger.info("✅ Cleanup completed successfully");
  } catch (error) {
    logger.error("❌ Error during shutdown cleanup:", error);
  }

  process.exit(0);
}

function setupShutdownHandlers() {
  process.once("SIGTERM", () =>
    void shutdownBareDirectWorker("signal"),
  );
  process.once("SIGINT", () => void shutdownBareDirectWorker("signal"));
}
