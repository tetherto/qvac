import process from "bare-process";
import Hyperswarm from "hyperswarm";
import crypto from "bare-crypto";
import { envSchema, type FirewallConfig } from "@/schemas/provide";
import { getSDKConfig } from "@/server/bare/registry/config-registry";
import { registerSwarm, unregisterSwarm } from "@/server/bare/runtime-lifecycle";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

function getHyperswarmSeedBuffer() {
  const parsedEnv = envSchema.safeParse(process.env);

  if (parsedEnv.success) {
    return Buffer.from(parsedEnv.data.QVAC_HYPERSWARM_SEED, "hex");
  } else {
    logger.info(
      `🎲 No seed provided, generating random seed (provider will have random identity)`,
    );
    return crypto.randomBytes(32);
  }
}

function createFirewallFunction(config?: FirewallConfig) {
  if (!config || config.publicKeys.length === 0) {
    return () => false;
  }

  const { mode, publicKeys } = config;
  const publicKeySet = new Set(publicKeys);

  return (remotePublicKey: Buffer) => {
    const remoteKeyHex = remotePublicKey.toString("hex");

    if (mode === "allow") {
      const allowed = publicKeySet.has(remoteKeyHex);
      if (!allowed) {
        logger.debug(
          `🚫 Firewall: Denied connection from ${remoteKeyHex.substring(0, 16)}... (not in allowlist)`,
        );
      } else {
        logger.debug(
          `✅ Firewall: Allowed connection from ${remoteKeyHex.substring(0, 16)}... (in allowlist)`,
        );
      }
      return !allowed;
    } else {
      const denied = publicKeySet.has(remoteKeyHex);
      if (denied) {
        logger.debug(
          `🚫 Firewall: Denied connection from ${remoteKeyHex.substring(0, 16)}... (in denylist)`,
        );
      } else {
        logger.debug(
          `✅ Firewall: Allowed connection from ${remoteKeyHex.substring(0, 16)}... (not in denylist)`,
        );
      }
      return denied;
    }
  };
}

function createSwarm(firewallConfig?: FirewallConfig) {
  const seed = getHyperswarmSeedBuffer();
  const firewall = createFirewallFunction(firewallConfig);
  const getRelays = () => {
    const config = getSDKConfig();
    const relayPublicKeys = config.swarmRelays;
    if (!relayPublicKeys || relayPublicKeys.length === 0) {
      return null;
    }
    return relayPublicKeys.map((key: string) => Buffer.from(key, "hex"));
  };

  const swarmOptions: {
    seed: Buffer;
    firewall: (remotePublicKey: Buffer) => boolean;
    relayThrough: () => Buffer[] | null;
  } = { seed, firewall, relayThrough: getRelays };

  return new Hyperswarm(swarmOptions);
}

let swarm: Hyperswarm | null = null;

const activeProviderTopics = new Set<string>();

export function getSwarm({
  firewallConfig,
}: {
  firewallConfig?: FirewallConfig | undefined;
} = {}) {
  if (swarm) {
    return swarm;
  }
  swarm = createSwarm(firewallConfig);
  registerSwarm(swarm, { label: "shared-swarm", createdAt: Date.now() });
  return swarm;
}

export function registerProviderTopic(topic: string) {
  activeProviderTopics.add(topic);
}

export function unregisterProviderTopic(topic: string) {
  activeProviderTopics.delete(topic);
}

export function hasActiveProviders(): boolean {
  return activeProviderTopics.size > 0;
}

export async function destroySwarm() {
  if (!swarm) return;

  const ref = swarm;
  swarm = null;

  try {
    await ref.destroy();
    unregisterSwarm(ref);
    activeProviderTopics.clear();
  } catch (error) {
    if (swarm === null) swarm = ref;
    throw error;
  }
}
