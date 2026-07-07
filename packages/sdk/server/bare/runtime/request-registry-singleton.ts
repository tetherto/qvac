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

// `completion` and `batchCompletion` both run on the same `@qvac/llm-llamacpp`
// instance, which funnels every `run()` (single-prompt and batch alike) through
// one per-instance exclusive run queue plus a single-job native runner. They
// therefore can't actually execute at once on the same model. Sharing one
// admission lane makes the SDK queue reflect that reality: a completion and a
// batch on the same model serialize FIFO at the SDK layer instead of both being
// admitted and silently serializing inside the addon (which hides them from the
// registry's queue-depth accounting, `requestId` diagnostics, and cancel).
const LLAMACPP_COMPLETION_SLOT_GROUP = 'llamacppCompletion'

function installDefaultPolicies(r: RequestRegistry): void {
  // A loaded model is a single native context (one KV-cache, single-slot
  // decode), so two same-model completions can't run in parallel. Serialize
  // rather than reject: the second waits FIFO. maxConcurrentPerModel: 1 is
  // today's reality — raise it once continuous batching lands. The depth cap
  // bounds queue memory. The shared slot group extends that serialization
  // across `completion` + `batchCompletion` on the same model (see note
  // above).
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
}

export function getRequestRegistry(): RequestRegistry {
  if (!registry) {
    registry = createRegistry()
    installDefaultPolicies(registry)
  }
  return registry
}

export { createRegistry as createRequestRegistry }
