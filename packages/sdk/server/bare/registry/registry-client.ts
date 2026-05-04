import { QVACRegistryClient } from "@qvac/registry-client";
import { getCacheDir } from "@/server/utils/cache/paths";
import {
  registerSwarm,
  unregisterSwarm,
  registerCorestore,
  unregisterCorestore,
} from "@/server/bare/runtime-lifecycle";
import { getServerLogger } from "@/logging";
import { DEFAULT_REGISTRY_CORE_KEY } from "@/constants";

const logger = getServerLogger();

// fd-lock retry budget for the registry corestore.
//
// We pass `corestoreOpts: { wait: false }` (tryLock semantics) and provide a
// JS-bounded retry budget here instead of letting Hypercore's underlying
// fd-lock issue a blocking flock(LOCK_EX) on a libuv worker thread. The
// blocking variant cannot be cancelled from JS, so if another SDK process
// holds the lock indefinitely it leaves a pending native handle that
// prevents process.exit() from terminating the worker — see QVAC-18197.
//
// With tryLock + bounded retries we get the same "tolerate transient locks
// during another SDK's startup/shutdown" property #1480 wanted, but every
// retry step is a fresh non-blocking syscall that surfaces failure to JS,
// so shutdown always remains cancellable.
const MAX_RETRIES = 8;
const BASE_DELAY_MS = 250;
const MAX_TOTAL_WAIT_MS = 10_000;

let registryClient: QVACRegistryClient | null = null;
let inflightInit: Promise<QVACRegistryClient> | null = null;

function isFdLockError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("File descriptor could not be locked");
  }
  return false;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initRegistryClient(): Promise<QVACRegistryClient> {
  let lastError: unknown;
  const deadline = Date.now() + MAX_TOTAL_WAIT_MS;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = new QVACRegistryClient({
        registryCoreKey: DEFAULT_REGISTRY_CORE_KEY,
        storage: getCacheDir(`registry-corestore/${DEFAULT_REGISTRY_CORE_KEY}`),
        corestoreOpts: { wait: false },
      });

      await client.ready();
      registryClient = client;

      if (registryClient.corestore) {
        registerCorestore(registryClient.corestore, {
          label: "registry-client",
          createdAt: Date.now(),
        });
      }
      if (registryClient.hyperswarm) {
        registerSwarm(registryClient.hyperswarm, {
          label: "registry-client",
          createdAt: Date.now(),
        });
      }

      logger.info("✅ Registry client ready");
      return client;
    } catch (error) {
      lastError = error;
      if (isFdLockError(error) && attempt < MAX_RETRIES) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          logger.warn(
            `Registry client fd-lock failed after ${MAX_TOTAL_WAIT_MS}ms wait budget exhausted (attempt ${attempt}/${MAX_RETRIES})`,
          );
          throw error;
        }
        const backoff = Math.min(
          BASE_DELAY_MS * Math.pow(2, attempt - 1),
          remaining,
        );
        logger.warn(
          `Registry client fd-lock failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${backoff}ms...`,
        );
        await delay(backoff);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

export async function getRegistryClient(): Promise<QVACRegistryClient> {
  if (registryClient) {
    logger.debug("Registry client reused");
    return registryClient;
  }

  if (inflightInit) {
    logger.debug("Registry client init already in progress, waiting...");
    return inflightInit;
  }

  logger.info("🔗 Creating new registry client...");

  inflightInit = initRegistryClient().finally(() => {
    inflightInit = null;
  });

  return inflightInit;
}

export async function closeRegistryClient(): Promise<void> {
  if (!registryClient) return;

  const client = registryClient;
  registryClient = null;

  const corestore = client.corestore;
  const hyperswarm = client.hyperswarm;

  logger.info("🔌 Closing registry client...");

  try {
    await client.close();
    logger.info("✅ Registry client closed");
  } catch (error) {
    logger.error(
      "❌ Error closing registry client:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (corestore) unregisterCorestore(corestore);
    if (hyperswarm) unregisterSwarm(hyperswarm);
  }
}

export function hasActiveRegistryClient(): boolean {
  return registryClient !== null;
}
