import {
  createRequestRegistry as createRegistry,
  type RequestRegistry
} from '@/server/bare/runtime/request-registry'

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
let registry: RequestRegistry | null = null

// completion + batchCompletion share one lane: singles and batches compete for
// the model's `parallel` slots first-come-first-serve.
const LLAMACPP_COMPLETION_SLOT_GROUP = 'llamacppCompletion'

// Concurrent disk-KV-cache turns would corrupt shared on-disk cache state, so on
// N-way models the handler serializes them on this dedicated cap-1 lane.
export const LLAMACPP_COMPLETION_CACHED_SLOT_GROUP = 'llamacppCompletionCached'

function installDefaultPolicies(r: RequestRegistry): void {
  // Cap is the model's `parallel`, passed per request by the handlers; the value
  // here is only the fallback when a caller supplies none.
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    maxQueueDepthPerModel: 64,
    sharedSlotGroup: LLAMACPP_COMPLETION_SLOT_GROUP
  })
  r.policy({
    kind: 'batchCompletion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    maxQueueDepthPerModel: 64,
    sharedSlotGroup: LLAMACPP_COMPLETION_SLOT_GROUP
  })
  // ACE-Step owns one active job per model. Starting another run replaces
  // the addon's active response, and model-scoped cancel targets that single
  // active job. Keep the SDK registry authoritative by admitting one AudioGen
  // request per model and queueing later requests FIFO.
  r.policy({
    kind: 'audiogen',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    maxQueueDepthPerModel: 64
  })
}

export function getRequestRegistry(): RequestRegistry {
  if (!registry) {
    registry = createRegistry()
    installDefaultPolicies(registry)
  }
  return registry
}

export { createRegistry as createRequestRegistry }
