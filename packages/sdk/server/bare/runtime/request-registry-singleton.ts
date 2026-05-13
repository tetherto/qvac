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
 * shared instance.
 */
let registry: RequestRegistry | null = null;

export function getRequestRegistry(): RequestRegistry {
  if (!registry) registry = createRegistry();
  return registry;
}

export { createRegistry as createRequestRegistry };
