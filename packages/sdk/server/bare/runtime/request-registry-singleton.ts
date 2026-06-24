import {
  createRequestRegistry as createRegistry,
  type RequestRegistry,
} from "@/server/bare/runtime/request-registry";

/**
 * Worker-process singleton. Every long-running request in this Bare
 * worker registers under this registry, so a `cancel({ requestId })` RPC
 * can find its target without the caller needing to know which plugin /
 * handler owns the request.
 *
 * Exposed alongside `createRequestRegistry()` rather than replacing it so
 * unit tests can spin up isolated registries without contaminating the
 * shared instance. On first use the singleton registers the SDK's
 * baseline concurrency policies.
 */
let registry: RequestRegistry | null = null;

function installDefaultPolicies(r: RequestRegistry): void {
  // A loaded model is a single native context (one KV-cache, single-slot
  // decode), so two same-model completions can't run in parallel. Serialize
  // rather than reject: the second waits FIFO. maxConcurrentPerModel: 1 is
  // today's reality — raise it once continuous batching lands. The depth cap
  // bounds queue memory.
  r.policy({
    kind: "completion",
    maxConcurrentPerModel: 1,
    onOverflow: "queue",
    maxQueueDepthPerModel: 64,
  });
}

export function getRequestRegistry(): RequestRegistry {
  if (!registry) {
    registry = createRegistry();
    installDefaultPolicies(registry);
  }
  return registry;
}

export { createRegistry as createRequestRegistry };
