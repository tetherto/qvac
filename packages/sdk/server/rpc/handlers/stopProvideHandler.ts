import type { StopProvideResponse } from "@/schemas/stop-provide";
import { unregisterProvider } from "@/server/bare/hyperswarm";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

// Decrements the active-provider counter. The shared connection listener
// (set up once in `provideHandler` per process) checks `hasActiveProviders()`
// before mounting an RPC server on incoming sockets, so once the counter
// reaches 0 inbound peers are dropped and remote calls stop being served.
//
// We deliberately do NOT destroy the swarm or unbind the keyPair from the
// DHT here, because the same swarm is also used by this SDK instance as a
// consumer (delegate-rpc-client.ts). Stopping the provider role must not
// kill outgoing delegation connections.
export function stopProvideHandler(): StopProvideResponse {
  try {
    unregisterProvider();

    return {
      type: "stopProvide" as const,
      success: true,
    };
  } catch (error) {
    logger.error("❌ Error in stop provide handler:", error);
    return {
      type: "stopProvide" as const,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
