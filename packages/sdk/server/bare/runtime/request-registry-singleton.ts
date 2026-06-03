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
  // A loaded llama.cpp model is one native context: one KV-cache, one
  // single-slot decode loop. Two concurrent `completion` requests on the
  // same model can't actually run in parallel — the legacy
  // `oneAtATimePerModel` rule rejected the second with
  // `RequestRejectedByPolicyError`. But coding agents (OpenCode, Cline, …)
  // routinely fire a main chat completion plus a background title /
  // summary call at the same model, so rejecting broke them and forced a
  // wasteful two-model-file workaround.
  //
  // Instead of rejecting, serialize: the second concurrent same-model
  // completion waits FIFO for the first to finish, then runs.
  // `maxConcurrentPerModel: 1` is the single-context reality today; bump it
  // to the addon's slot count once continuous batching lands and this flips
  // to N-way concurrent with no other change. The depth cap bounds memory
  // so a runaway client can't queue without limit (the 65th waiter rejects).
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
