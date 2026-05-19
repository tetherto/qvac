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
  // The llama.cpp addon owns one KV-cache + one decode loop per model,
  // so two concurrent `completionStream` requests on the same model
  // would interleave their token streams on the same logical session.
  r.policy({ kind: "completion", oneAtATimePerModel: true });
}

export function getRequestRegistry(): RequestRegistry {
  if (!registry) {
    registry = createRegistry();
    installDefaultPolicies(registry);
  }
  return registry;
}

export { createRegistry as createRequestRegistry };
