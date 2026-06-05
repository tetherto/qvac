import { withTimeout } from "@/utils/withTimeout";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export const DHT_BOOTSTRAP_WAIT_CAP_MS = 5000;

interface BootstrappableDht {
  bootstrapped: boolean;
  fullyBootstrapped(): Promise<void>;
}

// A cold routing table makes findPeer return empty -> spurious PEER_NOT_FOUND,
// so wait for bootstrap, but only when not yet ready to keep warm-path latency.
export async function ensureDhtBootstrapped(
  dht: BootstrappableDht,
  timeout: number | undefined,
): Promise<void> {
  if (dht.bootstrapped) return;
  const cap =
    timeout === undefined
      ? DHT_BOOTSTRAP_WAIT_CAP_MS
      : Math.min(timeout, DHT_BOOTSTRAP_WAIT_CAP_MS);
  try {
    await withTimeout(dht.fullyBootstrapped(), cap);
  } catch (error) {
    logger.warn(
      `DHT not bootstrapped within ${cap}ms before delegated connect; attempting anyway`,
      { error },
    );
  }
}

// Map an opaque DHT connect error onto why the peer was unreachable: not found
// on the DHT vs found-but-un-holepunchable. Relays only bridge after a peer is
// found, so they can never resolve a PEER_NOT_FOUND.
export function describeConnectFailure(
  error: unknown,
  publicKey: string,
  relayCount: number,
): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  const relayNote =
    relayCount > 0
      ? `${relayCount} swarm relay(s) configured`
      : "no swarm relays configured";

  switch (code) {
    case "PEER_NOT_FOUND":
      return `provider ${publicKey} was not found on the DHT — it may be offline, still bootstrapping, or unreachable from this network. Relays bridge a connection only after the provider is located, so they cannot find an unannounced provider (${relayNote}).`;
    case "PEER_CONNECTION_FAILED":
    case "CANNOT_HOLEPUNCH":
    case "REMOTE_NOT_HOLEPUNCHABLE":
    case "REMOTE_NOT_HOLEPUNCHING":
    case "HOLEPUNCH_ABORTED":
    case "HOLEPUNCH_PROBE_TIMEOUT":
    case "HOLEPUNCH_DOUBLE_RANDOMIZED_NATS":
      return `provider ${publicKey} was found but a connection could not be established (NAT/holepunch failure: ${code}; ${relayNote}).`;
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
