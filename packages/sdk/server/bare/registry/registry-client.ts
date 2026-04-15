import { QVACRegistryClient } from "@qvac/registry-client";
import { getCacheDir } from "@/server/utils/cache";
import {
  registerSwarm,
  unregisterSwarm,
  registerCorestore,
  unregisterCorestore,
} from "@/server/bare/runtime-lifecycle";
import { getServerLogger } from "@/logging";
import { DEFAULT_REGISTRY_CORE_KEY } from "@/constants";

const logger = getServerLogger();

let registryClient: QVACRegistryClient | null = null;

export async function getRegistryClient(): Promise<QVACRegistryClient> {
  if (registryClient) {
    logger.debug("Registry client reused");
    return registryClient;
  }

  logger.info("🔗 Creating new registry client...");

  registryClient = new QVACRegistryClient({
    registryCoreKey: DEFAULT_REGISTRY_CORE_KEY,
    storage: getCacheDir(`registry-corestore/${DEFAULT_REGISTRY_CORE_KEY}`),
  });

  await registryClient.ready();

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

  return registryClient;
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
