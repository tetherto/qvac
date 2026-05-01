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
import {
  acquireWorkerLock,
  releaseWorkerLock,
} from "@/server/utils/worker-lock";

let coreInitialized = false;
let rpcInitialized = false;
// Set true when the cleanup body has run at least once. Lets both
// cleanupForTerminate (pre-terminate path) and shutdownBareDirectWorker
// (signal/exit path) call runCleanup() without doing duplicate work.
let cleanupRan = false;
// Set true when shutdownBareDirectWorker is in flight. Distinct from
// cleanupRan: cleanupForTerminate must NOT set this, otherwise a later
// SIGTERM/SIGINT/uncaught-exception would early-return at the guard
// in shutdownBareDirectWorker and skip releaseWorkerLock + process.exit.
let isShuttingDown = false;

const logger = getServerLogger();

export function initializeWorkerCore(): { hasRPCConfig: boolean } {
  if (coreInitialized) {
    const validatedEnv = getValidatedEnv();
    return { hasRPCConfig: !!validatedEnv.QVAC_IPC_SOCKET_PATH };
  }

  startLogBuffering(SDK_LOG_ID);

  const { hasRPCConfig } = initEnv();

  acquireWorkerLock();
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
      const rpc = createIPCClient(ipcSocketPath, {
        onDisconnect: () => void shutdownBareDirectWorker("ipc-disconnect"),
      });
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

export type BareDirectShutdownReason =
  | "signal"
  | "rpc-close"
  | "uncaught-exception"
  | "unhandled-rejection"
  | "ipc-disconnect";

/**
 * Run the cleanup body shared by terminal and graceful-shutdown paths.
 * Clears plugin registries (which calls each addon's `releaseLogger` →
 * frees env-bound js_ref_t state), unloads all loaded models (which calls
 * each addon's `destroyInstance`), and closes infra (swarm, rag, downloads,
 * registry client). Does NOT touch the worker lock or call `process.exit`.
 *
 * Idempotent: subsequent calls are no-ops via the `cleanupRan` flag. The
 * underlying clearPlugins / unloadAllModels / closers are also idempotent
 * on empty registries, but the flag avoids the redundant log noise and
 * allocator churn.
 */
async function runCleanup(): Promise<void> {
  if (cleanupRan) return;
  cleanupRan = true;
  clearRegistries();
  await Promise.allSettled([
    destroySwarm(),
    closeAllRagInstances(),
    cleanupDownloads(),
    unloadAllModels(),
    closeRegistryClient(),
  ]);
}

/**
 * Pre-terminate cleanup, callable while the worker is still alive.
 *
 * On platforms where the worker lives in the same OS process as the JS host
 * (i.e. mobile via react-native-bare-kit Worklet), `process.exit()` would
 * kill the entire app. This path runs the same registry/model cleanup as
 * `shutdownBareDirectWorker` but skips the lock release + exit, leaving the
 * caller (typically the SDK client about to call `worklet.terminate()`)
 * responsible for tearing the worker down.
 *
 * Critical for clean termination: addons hold static state with js_ref_t
 * handles into the current V8 isolate; without this cleanup, those refs
 * survive into the next worklet's isolate and crash on first access.
 */
export async function cleanupForTerminate(): Promise<void> {
  // Intentionally does NOT set isShuttingDown — that flag is reserved for
  // shutdownBareDirectWorker so a later SIGTERM/SIGINT still gets to run
  // the lock release + process.exit path. runCleanup is idempotent on its
  // own, so a follow-up shutdownBareDirectWorker call won't redo the body.
  if (cleanupRan) return;

  logger.info("🧹 Pre-terminate cleanup starting...");
  try {
    await runCleanup();
    logger.info("✅ Pre-terminate cleanup completed");
  } catch (error) {
    logger.error("❌ Error during pre-terminate cleanup:", error);
  }
}

export async function shutdownBareDirectWorker(
  reason: BareDirectShutdownReason,
): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const messages: Record<BareDirectShutdownReason, string> = {
    signal: "🐻 Bare worker shutdown signal received, cleaning up...",
    "rpc-close": "🧹 Bare direct mode RPC closed, cleaning up...",
    "uncaught-exception": "💥 Uncaught exception, cleaning up...",
    "unhandled-rejection": "💥 Unhandled rejection, cleaning up...",
    "ipc-disconnect": "🔌 Parent IPC disconnected, cleaning up...",
  };
  logger.info(messages[reason]);

  try {
    // Idempotent: if cleanupForTerminate already ran, this is a no-op.
    await runCleanup();
    logger.info("✅ Cleanup completed successfully");
  } catch (error) {
    logger.error("❌ Error during shutdown cleanup:", error);
  }

  releaseWorkerLock();

  const isGraceful = reason === "signal" || reason === "rpc-close";
  process.exit(isGraceful ? 0 : 1);
}

function setupShutdownHandlers() {
  process.once("SIGTERM", () => void shutdownBareDirectWorker("signal"));
  process.once("SIGINT", () => void shutdownBareDirectWorker("signal"));

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception in worker:", err);
    void shutdownBareDirectWorker("uncaught-exception");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection in worker:", reason);
    void shutdownBareDirectWorker("unhandled-rejection");
  });
}
