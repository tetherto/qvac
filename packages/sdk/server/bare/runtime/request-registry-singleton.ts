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

// One admission lane per model for the llama.cpp addon: completion,
// batchCompletion, LLM translate, and finetune all key on
// (LLAMACPP_COMPLETION_SLOT_GROUP, modelId), so they compete for the model's
// `parallel` slots first-come-first-serve and share ONE bounded FIFO wait queue.
// The queue depth is the per-model cap below (64): once 64 requests across those
// kinds are waiting, the 65th begin is rejected with RequestRejectedByPolicyError.
// Disk-KV-cache turns ride the same lane and serialise same-file writes per cache
// path in the KV-cache session, so they need no separate group. NMT translate
// passes an infinite cap and never enters the lane, so it stays ungated.
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

export { createRegistry as createRequestRegistry }
