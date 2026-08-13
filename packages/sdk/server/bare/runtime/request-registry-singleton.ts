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
// the model's `parallel` slots first-come-first-serve. Disk-KV-cache turns ride
// the same lane and serialise same-file writes per cache path in the KV-cache
// session, so they never need a separate admission group.
const LLAMACPP_COMPLETION_SLOT_GROUP = 'llamacppCompletion'

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
  // Finetune's only stop is the addon's global cancel, which would kill
  // concurrent completions. Run it exclusively so nothing else is on the model.
  r.policy({
    kind: 'finetune',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    maxQueueDepthPerModel: 64,
    sharedSlotGroup: LLAMACPP_COMPLETION_SLOT_GROUP,
    exclusive: true
  })
  // LLM translate shares the completion lane as a reader (capped by `parallel`),
  // so a finetune blocks it too. NMT passes no cap and stays ungated.
  r.policy({
    kind: 'translate',
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

/**
 * Test-only: drop the worker singleton so the next `getRequestRegistry()`
 * builds a fresh one with default policies. `cleanupForTerminate()` leaves the
 * singleton in its terminal shutting-down state (every later `begin()` starts
 * aborted); a shared-process bare-test suite must reset it after exercising
 * terminate so subsequent tests get a live registry.
 *
 * @internal
 */
export function __resetRequestRegistrySingletonForTest(): void {
  registry = null
}

export { createRegistry as createRequestRegistry }
