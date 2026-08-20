import test from 'brittle'
import {
  createRequestRegistry,
  __requestRegistryTestHooks
} from '@/server/bare/runtime/request-registry'
import { RequestIdConflictError, RequestRejectedByPolicyError } from '@/utils/errors-server'

// -----------------------------------------------------------------------------
// RequestRegistry unit tests.
//
// Covers the contract the registry hands to handler authors:
//   - begin / get / list reflect a coherent in-flight set.
//   - cancel-by-requestId targets exactly one entry.
//   - cancel-by-modelId predicate fans out across entries with optional
//     kind narrowing.
//   - cancelAll fires every active request's signal exactly once.
//   - Disposing the managed context (via `await using`) flips the state
//     and removes the registry slot.
//   - parentSignal compositions abort the request when the parent does.
//   - RequestIdConflictError is thrown on duplicate ids.
// -----------------------------------------------------------------------------

test('registry: begin/get/list track in-flight requests', async (t) => {
  const r = createRequestRegistry()
  await using a = await r.begin({
    requestId: 'r-a',
    kind: 'completion',
    modelId: 'm1'
  })
  await using b = await r.begin({
    requestId: 'r-b',
    kind: 'embeddings',
    modelId: 'm2'
  })

  t.is(r.get('r-a')?.requestId, 'r-a')
  t.is(r.get('r-b')?.requestId, 'r-b')
  t.is(r.get('missing'), null)
  t.is(r.list().length, 2)

  // touch the variables so noUnusedLocals stays quiet.
  t.is(a.kind, 'completion')
  t.is(b.kind, 'embeddings')
})

test('registry: dispose removes the slot and flips state', async (t) => {
  const r = createRequestRegistry()

  async function run() {
    await using ctx = await r.begin({
      requestId: 'r-1',
      kind: 'completion',
      modelId: 'm1'
    })
    t.is(ctx.state, 'running')
    t.is(r.list().length, 1)
  }

  await run()
  t.is(r.list().length, 0, 'scope unwind removed the registry slot')
  t.is(r.get('r-1'), null)
})

test('registry: cancel by requestId aborts only that signal', async (t) => {
  const r = createRequestRegistry()
  await using a = await r.begin({
    requestId: 'r-a',
    kind: 'completion',
    modelId: 'm1'
  })
  await using b = await r.begin({
    requestId: 'r-b',
    kind: 'completion',
    modelId: 'm1'
  })

  const cancelled = r.cancel({ requestId: 'r-a' })
  t.is(cancelled, 1, 'exactly one entry cancelled')
  t.is(a.signal.aborted, true)
  t.is(a.state, 'cancelling')
  t.is(b.signal.aborted, false, 'sibling on the same model is untouched')
  t.is(b.state, 'running')
})

test('registry: a same-tick duplicate requestId is rejected', async (t) => {
  const r = createRequestRegistry()
  // Two begins with the same id, neither awaited before the other starts.
  const p1 = r.begin({ requestId: 'dup', kind: 'completion', modelId: 'm1' })
  const p2 = r.begin({ requestId: 'dup', kind: 'completion', modelId: 'm1' })
  const [a, b] = await Promise.allSettled([p1, p2])

  const fulfilled = [a, b].filter((x) => x.status === 'fulfilled')
  const rejected = [a, b].filter((x) => x.status === 'rejected')
  t.is(fulfilled.length, 1, 'exactly one begin admitted')
  t.is(rejected.length, 1, 'the duplicate was rejected')
  t.ok(
    rejected[0]?.status === 'rejected' && rejected[0].reason instanceof RequestIdConflictError,
    'duplicate rejected with RequestIdConflictError'
  )
  if (fulfilled[0]?.status === 'fulfilled') await fulfilled[0].value[Symbol.asyncDispose]()
})

test('registry: cancel-before-begin does not wait for a saturated lane', async (t) => {
  const r = createRequestRegistry()
  // Holder saturates a single-slot lane and is held for the whole test.
  await using holder = await r.begin({
    requestId: 'holder',
    kind: 'completion',
    modelId: 'm1',
    maxConcurrentPerModel: 1
  })
  t.ok(holder, 'holder admitted')

  // Cancel lands BEFORE begin: it only records a cancel-before-begin marker.
  r.cancel({ requestId: 'pre' })

  // Without the fix this begin would queue behind the still-held holder and
  // never resolve; with it, it skips admission and returns aborted at once.
  await using pre = await r.begin({
    requestId: 'pre',
    kind: 'completion',
    modelId: 'm1',
    maxConcurrentPerModel: 1
  })
  t.is(pre.signal.aborted, true, 'pre-cancelled begin resolves immediately aborted')
})

test('registry: cancel-by-requestId is idempotent and counts only first abort', async (t) => {
  const r = createRequestRegistry()
  await using ctx = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  t.is(r.cancel({ requestId: 'r-1' }), 1)
  t.is(r.cancel({ requestId: 'r-1' }), 0, 'second cancel returns 0')
  t.is(ctx.signal.aborted, true)
})

test('registry: cancel by modelId fans out across that model only', async (t) => {
  const r = createRequestRegistry()
  await using a = await r.begin({
    requestId: 'r-a',
    kind: 'completion',
    modelId: 'm1'
  })
  await using b = await r.begin({
    requestId: 'r-b',
    kind: 'embeddings',
    modelId: 'm1'
  })
  await using c = await r.begin({
    requestId: 'r-c',
    kind: 'completion',
    modelId: 'm2'
  })

  const cancelled = r.cancel({ modelId: 'm1' })
  t.is(cancelled, 2, 'both m1 entries cancelled')
  t.is(a.signal.aborted, true)
  t.is(b.signal.aborted, true)
  t.is(c.signal.aborted, false)
})

test('registry: cancel by modelId + kind narrows the target', async (t) => {
  const r = createRequestRegistry()
  await using a = await r.begin({
    requestId: 'r-a',
    kind: 'completion',
    modelId: 'm1'
  })
  await using b = await r.begin({
    requestId: 'r-b',
    kind: 'embeddings',
    modelId: 'm1'
  })

  const cancelled = r.cancel({ modelId: 'm1', kind: 'completion' })
  t.is(cancelled, 1, 'only the completion-kind entry cancelled')
  t.is(a.signal.aborted, true)
  t.is(b.signal.aborted, false)
})

test('registry: cancelAll fires every signal', async (t) => {
  const r = createRequestRegistry()
  await using a = await r.begin({
    requestId: 'r-a',
    kind: 'completion',
    modelId: 'm1'
  })
  await using b = await r.begin({
    requestId: 'r-b',
    kind: 'loadModel',
    modelId: 'm2'
  })
  await using c = await r.begin({
    requestId: 'r-c',
    kind: 'rag'
  })

  await r.cancelAll('shutdown')
  t.is(a.signal.aborted, true)
  t.is(b.signal.aborted, true)
  t.is(c.signal.aborted, true)
})

test('registry: parentSignal already aborted aborts the new context', async (t) => {
  const r = createRequestRegistry()
  const parent = new AbortController()
  parent.abort('shutdown')
  await using ctx = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1',
    parentSignal: parent.signal
  })
  t.is(ctx.signal.aborted, true)
  // The controller is aborted at begin time, so observers must see
  // `cancelling` rather than the momentarily-`running` state the
  // pre-cancel branch was already guarding against.
  t.is(ctx.state, 'cancelling')
})

test('registry: parentSignal aborts propagate to children', async (t) => {
  const r = createRequestRegistry()
  const parent = new AbortController()
  await using ctx = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1',
    parentSignal: parent.signal
  })
  t.is(ctx.signal.aborted, false)
  parent.abort('shutdown')
  t.is(ctx.signal.aborted, true)
})

test('registry: duplicate requestId throws RequestIdConflictError', async (t) => {
  const r = createRequestRegistry()
  await using first = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  t.is(first.kind, 'completion')
  await t.exception(
    async () => {
      await r.begin({ requestId: 'r-1', kind: 'completion', modelId: 'm1' })
    },
    RequestIdConflictError as unknown as new () => Error
  )
})

test('registry: an id stays reserved through async disposal, then frees cleanly', async (t) => {
  const r = createRequestRegistry()

  let releaseCleanup = () => {}
  const cleanupBlocked = new Promise<void>((resolve) => {
    releaseCleanup = resolve
  })

  const ctx = await r.begin({ requestId: 'dup-1', kind: 'completion', modelId: 'm1' })
  // A blocking deferred cleanup holds the scope mid-dispose, so the id sits in
  // the window where it is out of `entries` but teardown has not finished.
  ctx.scope.defer(() => cleanupBlocked)
  const disposing = ctx[Symbol.asyncDispose]()

  await t.exception(
    async () => {
      await r.begin({ requestId: 'dup-1', kind: 'completion', modelId: 'm1' })
    },
    RequestIdConflictError as unknown as new () => Error,
    'a same-id begin during disposal is rejected, not admitted concurrently'
  )
  t.is(r.cancel({ requestId: 'dup-1' }), 0, 'a cancel during disposal matches nothing')

  releaseCleanup()
  await disposing

  // Teardown done: the id is reusable and must not inherit the disposal-window
  // cancel as a stale cancel-before-begin marker.
  await using fresh = await r.begin({ requestId: 'dup-1', kind: 'completion', modelId: 'm1' })
  t.is(fresh.signal.aborted, false, 'the reused id starts clean, no stale cancel')
  t.is(fresh.state, 'running')
})

test('registry: end(requestId) sets state, disposes scope, and removes slot', async (t) => {
  const r = createRequestRegistry()
  let cleanupRan = 0
  const ctx = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  ctx.scope.defer(() => {
    cleanupRan++
  })

  await r.end('r-1', 'completed')
  t.is(cleanupRan, 1, 'scope unwound')
  t.is(ctx.state, 'completed')
  t.is(r.get('r-1'), null)
})

test('registry: end without prior begin is a no-op', async (t) => {
  const r = createRequestRegistry()
  await r.end('does-not-exist', 'completed')
  // no throw, no entries
  t.is(r.list().length, 0)
})

test("registry: end() detaches parent listener so long-lived parents don't accumulate listeners", async (t) => {
  // The `parentSignal` composition exists so a worker-level shutdown
  // signal can compose into per-request signals. Without an explicit
  // `detachParent` discipline, every `begin(...)` would leave a listener
  // on the long-lived parent for the lifetime of the worker — a slow
  // O(n requests) leak that's invisible until production-scale traffic.
  // Verify the listener is removed on the request's `end()` path.
  const parent = new AbortController()
  let adds = 0
  let removes = 0
  const origAdd = parent.signal.addEventListener.bind(parent.signal)
  const origRemove = parent.signal.removeEventListener.bind(parent.signal)
  parent.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
    adds++
    return origAdd(...args)
  }) as typeof parent.signal.addEventListener
  parent.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
    removes++
    return origRemove(...args)
  }) as typeof parent.signal.removeEventListener

  const r = createRequestRegistry()
  for (let i = 0; i < 5; i++) {
    const id = `r-${i}`
    const ctx = await r.begin({
      requestId: id,
      kind: 'completion',
      modelId: 'm1',
      parentSignal: parent.signal
    })
    t.is(ctx.state, 'running')
    await r.end(id, 'completed')
  }
  t.is(adds, 5, 'each begin() with parentSignal registered one listener')
  t.is(removes, 5, "each end() removed it — long-lived parent doesn't accumulate listeners")
})

test('registry: same-tick cancel-before-begin retroactively aborts the later begin() (Stop-button race close)', async (t) => {
  // Stop-button race: the client generates a `requestId`
  // and the user clicks Stop before the server-side `begin(...)` for
  // that id has landed. The registry has nothing to abort, so the
  // immediate `cancel(...)` still returns 0 ("no in-flight match" is
  // still the truth on the wire). The id is recorded in a bounded
  // "cancelled-before-begin" set, and the subsequent `begin(...)`
  // checks the set: if its id is present, the new controller is
  // aborted before the context is returned and the entry is consumed.
  // The surface contract is documented in
  // `request-lifecycle-system.mdc`.
  const r = createRequestRegistry()
  const cancelled = r.cancel({ requestId: 'r-1', reason: 'stop-button' })
  t.is(
    cancelled,
    0,
    'no entry yet — cancel still returns 0 (race remembered, not retroactively counted)'
  )

  await using ctx = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  t.is(
    ctx.signal.aborted,
    true,
    'subsequent begin() is retroactively aborted by the pre-begin cancel'
  )
  t.is(ctx.state, 'cancelling', "context starts in 'cancelling' so observers see a coherent state")
  t.is(
    String((ctx.signal as { reason?: unknown }).reason),
    'stop-button',
    'the recorded cancel reason is forwarded to the aborted controller'
  )
})

test('registry: a begin racing withModelDraining starts aborted (drain barrier, not a one-time snapshot)', async (t) => {
  // begin() reserves its id then awaits acquireSlot, so the RegistryEntry lands
  // a microtask after reservation. A drain that only
  // snapshotted `entries` would miss such a begin and let it register an
  // unaborted active request against a model being torn down. withModelDraining
  // holds `drainingModels` across teardown, and begin() re-checks it AFTER slot
  // acquisition, so a same-tick begin in the reservation gap starts aborted.
  const r = createRequestRegistry()

  // Start the begin but do NOT await it: it reserves 'race' and suspends on
  // acquireSlot with an immediately-available slot.
  const racing = r.begin({
    requestId: 'race',
    kind: 'completion',
    modelId: 'm',
    maxConcurrentPerModel: 1
  })

  // Drain the model to teardown while that begin is mid-admission.
  let teardownRan = false
  await r.withModelDraining('m', async () => {
    teardownRan = true
  })

  await using ctx = await racing
  t.is(teardownRan, true, 'teardown ran')
  t.is(ctx.signal.aborted, true, 'the racing begin starts aborted, not a live unaborted request')
  t.is(
    String((ctx.signal as { reason?: unknown }).reason),
    'modelUnload',
    'aborted for model unload, not left running against a torn-down model'
  )
  t.is(ctx.state, 'cancelling', "context starts in 'cancelling'")
})

test('registry: a second begin() with the same id (UUID retry) after the race is consumed runs cleanly', async (t) => {
  // The Stop-button race close consumes its entry on the matching
  // `begin(...)`. In practice ids are UUIDv4 and never reused, but a
  // buggy client could retry an id whose first attempt was already
  // aborted (and its scope torn down). The second begin must NOT see
  // a phantom pre-cancel — entries are single-use.
  const r = createRequestRegistry()
  r.cancel({ requestId: 'r-1' })

  async function firstAttempt() {
    await using ctx = await r.begin({
      requestId: 'r-1',
      kind: 'completion',
      modelId: 'm1'
    })
    t.is(ctx.signal.aborted, true, 'first attempt is aborted by the race close')
  }
  await firstAttempt()

  await using second = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  t.is(
    second.signal.aborted,
    false,
    'second attempt with the same id is unaffected — pre-cancel entry was consumed'
  )
})

test('registry: bounded cancel-before-begin set does not grow past its cap (TTL + size eviction)', async (t) => {
  // The race-close map must be bounded so a malicious / buggy client
  // can't fire 100k `cancel({ requestId: <unique> })` calls and grow
  // the registry's memory unboundedly. The cap is documented at the
  // module top (`CANCEL_BEFORE_BEGIN_MAX_ENTRIES`) and exported via
  // `__requestRegistryTestHooks` for assertion stability.
  const r = createRequestRegistry()
  const cap = __requestRegistryTestHooks.cancelBeforeBeginMaxEntries
  const overshoot = cap + 64 // fire well past the cap

  const sizeProbe = r as unknown as { __cancelBeforeBeginSize: () => number }

  for (let i = 0; i < overshoot; i++) {
    r.cancel({ requestId: `r-${i}` })
  }
  t.is(
    sizeProbe.__cancelBeforeBeginSize() <= cap,
    true,
    `internal map stays within the documented cap of ${cap} entries`
  )

  // The oldest entries should have been evicted; the most recently
  // inserted id should still be honoured on the matching begin(...).
  const newestId = `r-${overshoot - 1}`
  await using newest = await r.begin({
    requestId: newestId,
    kind: 'completion',
    modelId: 'm1'
  })
  t.is(
    newest.signal.aborted,
    true,
    'the freshest pre-cancel still wins the race (oldest entries evicted, newest preserved)'
  )

  // And one of the early (presumed-evicted) ids should NOT trigger a
  // retroactive abort, because its entry was bumped out by the cap.
  await using ancient = await r.begin({
    requestId: 'r-0',
    kind: 'completion',
    modelId: 'm1'
  })
  t.is(
    ancient.signal.aborted,
    false,
    'an evicted pre-cancel no longer affects later begin() — bound holds'
  )
})

test("registry: derived terminal state is 'cancelled' if signal aborted, 'completed' otherwise", async (t) => {
  const r = createRequestRegistry()

  async function cancelledRun() {
    await using ctx = await r.begin({
      requestId: 'r-cancelled',
      kind: 'completion',
      modelId: 'm1'
    })
    r.cancel({ requestId: 'r-cancelled' })
    return ctx
  }
  const cancelled = await cancelledRun()
  t.is(cancelled.state, 'cancelled')

  async function happyRun() {
    await using ctx = await r.begin({
      requestId: 'r-happy',
      kind: 'completion',
      modelId: 'm1'
    })
    return ctx
  }
  const happy = await happyRun()
  t.is(happy.state, 'completed')
})

// -----------------------------------------------------------------------------
// Concurrency policy (Deliverable 2)
//
// Pins the `oneAtATimePerModel` admission rule registered via
// `registry.policy(...)`. The shared singleton wires this for the
// `completion` kind so two concurrent `completionStream` requests on
// the same model can't interleave on the llama.cpp KV-cache; these
// tests use an isolated registry instance so each policy variant can
// be exercised without contaminating the worker-wide one.
// -----------------------------------------------------------------------------

test('policy: oneAtATimePerModel rejects a second begin on the same (kind, modelId)', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', oneAtATimePerModel: true })

  await using first = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  t.is(first.requestId, 'r-1')

  // Throws the dedicated policy class so handler / RPC code can
  // `instanceof` narrow without parsing the error message.
  await t.exception(
    async () => {
      await r.begin({
        requestId: 'r-2',
        kind: 'completion',
        modelId: 'm1'
      })
    },
    RequestRejectedByPolicyError as unknown as new () => Error
  )

  // The rejected begin must not leave a slot behind — the registry's
  // in-flight set still only carries the first request.
  t.is(r.list().length, 1)
  t.is(r.get('r-2'), null)
})

test('policy: oneAtATimePerModel scopes admission per (kind, modelId), not globally', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', oneAtATimePerModel: true })

  // Same kind, different model — allowed.
  await using a = await r.begin({
    requestId: 'r-a',
    kind: 'completion',
    modelId: 'm1'
  })
  await using b = await r.begin({
    requestId: 'r-b',
    kind: 'completion',
    modelId: 'm2'
  })
  t.is(a.modelId, 'm1')
  t.is(b.modelId, 'm2')

  // Different kind, same model — allowed because the policy is keyed
  // by `kind`. (Today only `completion` carries a policy; an
  // embeddings request piggy-backing on the same model is fine.)
  await using c = await r.begin({
    requestId: 'r-c',
    kind: 'embeddings',
    modelId: 'm1'
  })
  t.is(c.kind, 'embeddings')

  t.is(r.list().length, 3)
})

test('policy: oneAtATimePerModel ignores requests without modelId', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', oneAtATimePerModel: true })

  // Both have no modelId — policy has no key to match against, so
  // both are admitted. This is the documented behaviour for
  // model-less requests (e.g. handlers that don't yet attach a
  // modelId to their `begin(...)` call).
  await using a = await r.begin({ requestId: 'r-a', kind: 'completion' })
  await using b = await r.begin({ requestId: 'r-b', kind: 'completion' })
  t.is(a.modelId, undefined)
  t.is(b.modelId, undefined)
  t.is(r.list().length, 2)
})

test('policy: disposing the holder releases admission for the next request', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', oneAtATimePerModel: true })

  async function runFirstThenSecond() {
    {
      await using first = await r.begin({
        requestId: 'r-1',
        kind: 'completion',
        modelId: 'm1'
      })
      t.is(first.requestId, 'r-1')
    }
    // Once the await-using block above unwinds, the slot is released.
    await using second = await r.begin({
      requestId: 'r-2',
      kind: 'completion',
      modelId: 'm1'
    })
    t.is(second.requestId, 'r-2')
  }
  await runFirstThenSecond()
})

test('policy: cancel without dispose does NOT release admission', async (t) => {
  // The slot is held until the handler scope unwinds, not when the
  // request is cancelled — the addon's KV-cache / decode loop is
  // still owned by the cancelled request as it drains. A future
  // contributor reading the brief criterion alone might assume
  // `cancel()` clears admission; this test pins the actual contract.
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', oneAtATimePerModel: true })

  await using first = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  r.cancel({ requestId: 'r-1' })
  t.is(first.signal.aborted, true)
  t.is(first.state, 'cancelling')

  await t.exception(
    () =>
      r.begin({
        requestId: 'r-2',
        kind: 'completion',
        modelId: 'm1'
      }),
    RequestRejectedByPolicyError as unknown as new () => Error
  )
  t.is(r.list().length, 1)
})

test('policy: registering a second time replaces the previous policy', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', oneAtATimePerModel: true })
  r.policy({ kind: 'completion', oneAtATimePerModel: false })

  // Disabling the rule re-opens admission — concurrent begins on the
  // same `(kind, modelId)` are accepted again.
  await using a = await r.begin({
    requestId: 'r-a',
    kind: 'completion',
    modelId: 'm1'
  })
  await using b = await r.begin({
    requestId: 'r-b',
    kind: 'completion',
    modelId: 'm1'
  })
  t.is(r.list().length, 2)
  t.is(a.modelId, 'm1')
  t.is(b.modelId, 'm1')
})

test('policy: kinds without a registered policy are unconstrained', async (t) => {
  const r = createRequestRegistry()
  // No `r.policy(...)` call for `embeddings` — admission must stay
  // open even though `completion` carries a strict rule.
  r.policy({ kind: 'completion', oneAtATimePerModel: true })

  await using a = await r.begin({
    requestId: 'r-a',
    kind: 'embeddings',
    modelId: 'm1'
  })
  await using b = await r.begin({
    requestId: 'r-b',
    kind: 'embeddings',
    modelId: 'm1'
  })
  t.is(r.list().length, 2)
  t.is(a.kind, 'embeddings')
  t.is(b.kind, 'embeddings')
})

// -----------------------------------------------------------------------------
// Per-(kind, modelId) FIFO admission queue (QVAC-19346)
//
// The completion policy now serializes instead of rejecting: a second
// concurrent request to the same (kind, modelId) waits FIFO for a slot
// rather than throwing. `maxConcurrentPerModel` is the slot count (1 today,
// the addon's batching width later); `onOverflow`, `maxQueueDepthPerModel`,
// and `queueTimeoutMs` bound the wait. These tests drive the queue with an
// isolated registry and manual dispose so the FIFO ordering, hand-off, and
// teardown invariants are pinned without relying on the worker singleton.
// -----------------------------------------------------------------------------

/** Let any already-scheduled microtasks/timers settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

function keyStateProbe(r: ReturnType<typeof createRequestRegistry>): {
  __keyStateSize: () => number
} {
  return r as unknown as { __keyStateSize: () => number }
}

test('policy: a second same-model AudioGen request waits FIFO', async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'audiogen',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue'
  })
  const first = await r.begin({
    requestId: 'audiogen-policy-r-1',
    kind: 'audiogen',
    modelId: 'audiogen-policy-m-1'
  })

  let secondResolved = false
  const secondPromise = r
    .begin({
      requestId: 'audiogen-policy-r-2',
      kind: 'audiogen',
      modelId: 'audiogen-policy-m-1'
    })
    .then((ctx) => {
      secondResolved = true
      return ctx
    })

  await settle()
  t.is(secondResolved, false, 'second AudioGen request waits for the model slot')

  await first[Symbol.asyncDispose]()
  const second = await secondPromise
  t.is(secondResolved, true, 'second AudioGen request is admitted after the first ends')
  t.is(second.requestId, 'audiogen-policy-r-2')

  await second[Symbol.asyncDispose]()
})

test('queue: a second same-model begin waits FIFO until the first disposes', async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue'
  })

  const first = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })

  let secondResolved = false
  const secondPromise = r
    .begin({ requestId: 'r-2', kind: 'completion', modelId: 'm1' })
    .then((ctx) => {
      secondResolved = true
      return ctx
    })

  await settle()
  t.is(secondResolved, false, 'second begin is queued, not yet admitted')
  t.is(r.list().length, 1, 'only the first request is in flight')

  await first[Symbol.asyncDispose]()
  const second = await secondPromise
  t.is(secondResolved, true, 'disposing the first admitted the queued second')
  t.is(second.requestId, 'r-2')
  t.is(r.list().length, 1, 'now only the second is in flight')

  await second[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('queue: waiters are admitted in FIFO enqueue order', async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue'
  })

  const holder = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })

  const admitted: string[] = []
  const enqueue = (id: string) =>
    r.begin({ requestId: id, kind: 'completion', modelId: 'm1' }).then((ctx) => {
      admitted.push(id)
      return ctx
    })

  const p2 = enqueue('r-2')
  const p3 = enqueue('r-3')
  const p4 = enqueue('r-4')
  await settle()
  t.alike(admitted, [], 'nothing admitted while the holder runs')

  await holder[Symbol.asyncDispose]()
  const c2 = await p2
  await c2[Symbol.asyncDispose]()
  const c3 = await p3
  await c3[Symbol.asyncDispose]()
  const c4 = await p4
  await c4[Symbol.asyncDispose]()

  t.alike(admitted, ['r-2', 'r-3', 'r-4'], 'admitted strictly in enqueue order')
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test("queue: a different model is never blocked by another model's queue", async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue'
  })

  await using m1 = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })

  // m1 is at capacity, but m2 must be admitted immediately — gating is
  // strictly per (kind, modelId).
  await using m2 = await r.begin({
    requestId: 'r-2',
    kind: 'completion',
    modelId: 'm2'
  })

  t.is(m1.modelId, 'm1')
  t.is(m2.modelId, 'm2')
  t.is(r.list().length, 2, 'both run concurrently — distinct models')
})

test('queue: maxConcurrentPerModel = 2 runs two and queues the third', async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 2,
    onOverflow: 'queue'
  })

  const c1 = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  const c2 = await r.begin({
    requestId: 'r-2',
    kind: 'completion',
    modelId: 'm1'
  })
  t.is(r.list().length, 2, 'two slots ⇒ two run concurrently')

  let thirdResolved = false
  const thirdPromise = r
    .begin({ requestId: 'r-3', kind: 'completion', modelId: 'm1' })
    .then((ctx) => {
      thirdResolved = true
      return ctx
    })
  await settle()
  t.is(thirdResolved, false, 'third waits while both slots are taken')

  await c1[Symbol.asyncDispose]()
  const c3 = await thirdPromise
  t.is(thirdResolved, true, 'freeing one slot admitted the third')

  await c2[Symbol.asyncDispose]()
  await c3[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test("queue: onOverflow 'reject' still throws RequestRejectedByPolicyError", async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'reject'
  })

  await using first = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  t.is(first.requestId, 'r-1')

  await t.exception(
    () => r.begin({ requestId: 'r-2', kind: 'completion', modelId: 'm1' }),
    RequestRejectedByPolicyError as unknown as new () => Error
  )
  t.is(r.list().length, 1, 'rejected begin left no slot behind')
})

test('queue: a sharedSlotGroup serializes different kinds on the same model', async (t) => {
  // Mirrors the singleton wiring: completion + batchCompletion share one lane
  // so a completion and a batch on the same model contend for a single
  // admission pool rather than each getting an independent (kind, modelId) slot.
  const r = createRequestRegistry()
  const sharedSlotGroup = 'llamacppCompletion'
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    sharedSlotGroup
  })
  r.policy({
    kind: 'batchCompletion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    sharedSlotGroup
  })

  const completion = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })

  let batchResolved = false
  const batchPromise = r
    .begin({ requestId: 'r-2', kind: 'batchCompletion', modelId: 'm1' })
    .then((ctx) => {
      batchResolved = true
      return ctx
    })

  await settle()
  t.is(
    batchResolved,
    false,
    'batchCompletion queues behind the running completion on the shared lane'
  )
  t.is(r.list().length, 1, 'only the completion is in flight')

  await completion[Symbol.asyncDispose]()
  const batch = await batchPromise
  t.is(batchResolved, true, 'disposing the completion admitted the batch')
  t.is(batch.requestId, 'r-2')

  await batch[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('queue: a kind outside the sharedSlotGroup is not blocked by the lane', async (t) => {
  // embeddings has no policy and isn't part of the completion lane, so it
  // must run concurrently with a completion holding the shared slot.
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    sharedSlotGroup: 'llamacppCompletion'
  })

  await using completion = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  await using embed = await r.begin({
    requestId: 'r-2',
    kind: 'embeddings',
    modelId: 'm1'
  })

  t.is(completion.requestId, 'r-1')
  t.is(embed.requestId, 'r-2')
  t.is(r.list().length, 2, 'embeddings runs alongside the completion lane')
})

test('queue: maxQueueDepthPerModel caps the queue and rejects the overflow', async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    maxQueueDepthPerModel: 2
  })

  const holder = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  // Two waiters fill the queue (depth 2).
  const p2 = r.begin({ requestId: 'r-2', kind: 'completion', modelId: 'm1' })
  const p3 = r.begin({ requestId: 'r-3', kind: 'completion', modelId: 'm1' })
  await settle()

  // The third waiter would exceed the depth cap ⇒ reject immediately.
  await t.exception(
    () => r.begin({ requestId: 'r-4', kind: 'completion', modelId: 'm1' }),
    RequestRejectedByPolicyError as unknown as new () => Error
  )

  // Drain the legitimately-queued waiters so the test leaves nothing pending.
  await holder[Symbol.asyncDispose]()
  const c2 = await p2
  await c2[Symbol.asyncDispose]()
  const c3 = await p3
  await c3[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('queue: a waiter past queueTimeoutMs rejects; a timely hand-off clears its timer', async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    queueTimeoutMs: 20
  })

  const holder = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })

  // r-2 waits behind the still-running holder and times out.
  await t.exception(
    () => r.begin({ requestId: 'r-2', kind: 'completion', modelId: 'm1' }),
    RequestRejectedByPolicyError as unknown as new () => Error
  )

  // A waiter that is handed a slot before its timeout must have its timer
  // cleared (no late rejection, no leaked timer keeping the process alive).
  const p3 = r.begin({ requestId: 'r-3', kind: 'completion', modelId: 'm1' })
  await holder[Symbol.asyncDispose]()
  const c3 = await p3
  await c3[Symbol.asyncDispose]()
  await settle()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('queue: cancel({ requestId }) on a queued waiter cancels it promptly', async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue'
  })

  const holder = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  const queuedPromise = r.begin({
    requestId: 'r-2',
    kind: 'completion',
    modelId: 'm1'
  })
  await settle()

  // Stop button on the still-queued request: counted as one cancelled, and
  // its begin resolves into an already-aborted context (clean cancel, not a
  // thrown error) — it never had to wait for the holder to finish.
  const cancelled = r.cancel({ requestId: 'r-2', reason: 'stop-button' })
  t.is(cancelled, 1, 'the queued request was cancelled')

  const queued = await queuedPromise
  t.is(queued.signal.aborted, true, 'queued begin resolves aborted')
  t.is(queued.state, 'cancelling', 'and starts in a coherent cancelling state')

  await queued[Symbol.asyncDispose]()
  await holder[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('queue: a duplicate requestId while queued is rejected and the original waiter survives', async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue'
  })

  const holder = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  // r-2 queues behind the holder.
  const queuedPromise = r.begin({
    requestId: 'r-2',
    kind: 'completion',
    modelId: 'm1'
  })
  await settle()

  // A begin reusing the still-queued id must conflict, not silently enqueue a
  // duplicate that overwrites r-2's `waitersById` index (which would leave the
  // original r-2 unreachable by `cancel({ requestId })`).
  await t.exception(
    async () => {
      await r.begin({ requestId: 'r-2', kind: 'completion', modelId: 'm1' })
    },
    RequestIdConflictError as unknown as new () => Error
  )

  // The original r-2 waiter is intact: cancelling it by id still finds and
  // cancels exactly one queued request.
  const cancelled = r.cancel({ requestId: 'r-2', reason: 'stop-button' })
  t.is(cancelled, 1, 'the original queued waiter is still reachable by id')

  const queued = await queuedPromise
  t.is(queued.signal.aborted, true, 'original queued waiter resolves aborted')

  await queued[Symbol.asyncDispose]()
  await holder[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('queue: cancel({ modelId }) drains queued waiters for that model', async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue'
  })

  const holder = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  const queuedPromise = r.begin({
    requestId: 'r-2',
    kind: 'completion',
    modelId: 'm1'
  })
  await settle()

  // Broad cancel: the in-flight holder is aborted (1) and the queued waiter
  // is drained (1) — both counted.
  const cancelled = r.cancel({ modelId: 'm1' })
  t.is(cancelled, 2, 'in-flight + queued both cancelled')

  const queued = await queuedPromise
  t.is(queued.signal.aborted, true, 'drained waiter resolves aborted')

  await queued[Symbol.asyncDispose]()
  await holder[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('queue: cancelAll drains queued waiters so no begin() promise hangs', async (t) => {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue'
  })

  const holder = await r.begin({
    requestId: 'r-1',
    kind: 'completion',
    modelId: 'm1'
  })
  // Attach the rejection handler synchronously so the teardown rejection is
  // never an unhandled promise.
  const p2 = r.begin({ requestId: 'r-2', kind: 'completion', modelId: 'm1' }).then(
    () => 'resolved' as const,
    (err) => err
  )
  const p3 = r.begin({ requestId: 'r-3', kind: 'completion', modelId: 'm1' }).then(
    () => 'resolved' as const,
    (err) => err
  )
  await settle()

  await r.cancelAll('modelUnload')

  const e2 = await p2
  const e3 = await p3
  t.ok(e2 instanceof RequestRejectedByPolicyError, 'queued waiter rejected on teardown')
  t.ok(e3 instanceof RequestRejectedByPolicyError, 'second queued waiter rejected on teardown')
  t.is(holder.signal.aborted, true, 'the in-flight holder was aborted too')

  await holder[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

// -----------------------------------------------------------------------------
// Per-request concurrency (multi-job continuous batching).
//
// A loaded model's real slot count is its own `parallel`, which varies per
// model — so the completionStream handler passes it as
// `begin({ maxConcurrentPerModel })` instead of baking one number into the
// per-kind policy. Disk-KV-cache completions ride the same lane and serialize
// same-file writes per cache path inside the KV-cache session, so admission
// stays uniform across cached and plain completions.
// -----------------------------------------------------------------------------

test('policy: per-request maxConcurrentPerModel overrides the kind default and admits N-way', async (t) => {
  const r = createRequestRegistry()
  // Policy default serializes; the per-request override opens the gate to the
  // model's `parallel` (3 here).
  r.policy({ kind: 'completion', maxConcurrentPerModel: 1, onOverflow: 'queue' })

  const opts = (id: string) => ({
    requestId: id,
    kind: 'completion' as const,
    modelId: 'm1',
    maxConcurrentPerModel: 3
  })

  const a = await r.begin(opts('r-1'))
  const b = await r.begin(opts('r-2'))
  const c = await r.begin(opts('r-3'))
  t.is(r.list().length, 3, 'three concurrent completions admitted on one model')

  let fourthResolved = false
  const fourth = r.begin(opts('r-4')).then((ctx) => {
    fourthResolved = true
    return ctx
  })
  await settle()
  t.is(fourthResolved, false, 'the fourth queues once the model is at its 3-slot cap')

  await a[Symbol.asyncDispose]()
  const d = await fourth
  t.is(fourthResolved, true, 'freeing one slot admits the queued fourth')

  await b[Symbol.asyncDispose]()
  await c[Symbol.asyncDispose]()
  await d[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('policy: per-request maxConcurrentPerModel is scoped per model', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', maxConcurrentPerModel: 1, onOverflow: 'queue' })

  // m1 was loaded with parallel=2, m2 with parallel=1.
  const big1 = await r.begin({
    requestId: 'a-1',
    kind: 'completion',
    modelId: 'm1',
    maxConcurrentPerModel: 2
  })
  const big2 = await r.begin({
    requestId: 'a-2',
    kind: 'completion',
    modelId: 'm1',
    maxConcurrentPerModel: 2
  })
  t.is(r.list().length, 2, 'm1 admits two concurrently at its own cap')

  const small1 = await r.begin({
    requestId: 'b-1',
    kind: 'completion',
    modelId: 'm2',
    maxConcurrentPerModel: 1
  })
  let small2Resolved = false
  const small2 = r
    .begin({ requestId: 'b-2', kind: 'completion', modelId: 'm2', maxConcurrentPerModel: 1 })
    .then((ctx) => {
      small2Resolved = true
      return ctx
    })
  await settle()
  t.is(small2Resolved, false, "m2's second request queues at its own 1-slot cap, unaffected by m1")

  await small1[Symbol.asyncDispose]()
  const small2ctx = await small2
  await big1[Symbol.asyncDispose]()
  await big2[Symbol.asyncDispose]()
  await small2ctx[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('policy: a cached completion shares the lane and counts toward the cap (no bypass)', async (t) => {
  const r = createRequestRegistry()
  const sharedSlotGroup = 'llamacppCompletion'
  r.policy({ kind: 'completion', maxConcurrentPerModel: 1, onOverflow: 'queue', sharedSlotGroup })

  // A cached completion is admitted exactly like a plain one now — no separate
  // slotGroup lane — so it counts toward `parallel` and keeps its FCFS place
  // instead of jumping the queue. Same-file write safety lives in the KV-cache
  // session, not here.
  const opts = (id: string) => ({
    requestId: id,
    kind: 'completion' as const,
    modelId: 'm1',
    maxConcurrentPerModel: 2
  })

  const p1 = await r.begin(opts('p-1'))
  const p2 = await r.begin(opts('p-2'))
  t.is(r.list().length, 2, 'two completions fill the shared lane at cap=2')

  let p3Resolved = false
  const p3 = r.begin(opts('p-3')).then((ctx) => {
    p3Resolved = true
    return ctx
  })
  // A "cached" completion fired after p3 — identical admission opts, so it must
  // queue behind p3 rather than bypass the cap onto a private lane.
  let cachedResolved = false
  const cached = r.begin(opts('c-1')).then((ctx) => {
    cachedResolved = true
    return ctx
  })
  await settle()
  t.is(p3Resolved, false, 'the third request queues once the lane is at cap')
  t.is(cachedResolved, false, 'the cached completion does NOT bypass the cap or jump the queue')

  await p1[Symbol.asyncDispose]()
  const p3ctx = await p3
  t.is(p3Resolved, true, 'freeing a slot admits p3 first (FCFS preserved)')
  await settle()
  t.is(cachedResolved, false, 'freeing one slot admits exactly one waiter, not the cached one too')

  await p2[Symbol.asyncDispose]()
  const cachedCtx = await cached
  t.is(cachedResolved, true, 'the cached completion is admitted only after its FCFS turn')

  await p3ctx[Symbol.asyncDispose]()
  await cachedCtx[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('policy: completion and batchCompletion share one lane and run concurrently up to the cap', async (t) => {
  const r = createRequestRegistry()
  const sharedSlotGroup = 'llamacppCompletion'
  // Mirrors the singleton: both kinds share the lane; the per-request cap is
  // the model's `parallel` (2 here), so a single and a batch run together.
  r.policy({ kind: 'completion', maxConcurrentPerModel: 1, onOverflow: 'queue', sharedSlotGroup })
  r.policy({
    kind: 'batchCompletion',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    sharedSlotGroup
  })

  const single = await r.begin({
    requestId: 's-1',
    kind: 'completion',
    modelId: 'm1',
    maxConcurrentPerModel: 2
  })
  const batch = await r.begin({
    requestId: 'b-1',
    kind: 'batchCompletion',
    modelId: 'm1',
    maxConcurrentPerModel: 2
  })
  t.is(r.list().length, 2, 'a single completion and a batch run concurrently on the shared lane')

  let thirdResolved = false
  const third = r
    .begin({ requestId: 's-2', kind: 'completion', modelId: 'm1', maxConcurrentPerModel: 2 })
    .then((ctx) => {
      thirdResolved = true
      return ctx
    })
  await settle()
  t.is(thirdResolved, false, 'a third request queues once the shared lane is at its 2-slot cap')

  await batch[Symbol.asyncDispose]()
  const thirdCtx = await third
  t.is(thirdResolved, true, 'freeing a shared slot admits the queued request regardless of kind')

  await single[Symbol.asyncDispose]()
  await thirdCtx[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

// -----------------------------------------------------------------------------
// Exclusive (reader/writer) admission. A writer (finetune) holds the shared
// lane alone; readers (completion) run N-way but never alongside it — so
// finetune's only-global cancel can't touch a concurrent completion.
// -----------------------------------------------------------------------------

const RW_LANE = 'llamacppCompletion'
function rwRegistry() {
  const r = createRequestRegistry()
  r.policy({
    kind: 'completion',
    maxConcurrentPerModel: 2,
    onOverflow: 'queue',
    sharedSlotGroup: RW_LANE
  })
  r.policy({
    kind: 'finetune',
    maxConcurrentPerModel: 1,
    onOverflow: 'queue',
    sharedSlotGroup: RW_LANE,
    exclusive: true
  })
  return r
}

test('exclusive: a writer waits until active readers drain, then is admitted', async (t) => {
  const r = rwRegistry()
  const c1 = await r.begin({ requestId: 'c-1', kind: 'completion', modelId: 'm1' })
  const c2 = await r.begin({ requestId: 'c-2', kind: 'completion', modelId: 'm1' })

  let ftResolved = false
  const ftP = r.begin({ requestId: 'ft', kind: 'finetune', modelId: 'm1' }).then((ctx) => {
    ftResolved = true
    return ctx
  })
  await settle()
  t.is(ftResolved, false, 'writer waits while two readers hold the lane')

  await c1[Symbol.asyncDispose]()
  await settle()
  t.is(ftResolved, false, 'still waits with one reader active')

  await c2[Symbol.asyncDispose]()
  const ft = await ftP
  t.is(ftResolved, true, 'writer admitted once the lane is empty')

  await ft[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('exclusive: an active writer blocks readers; releasing it drains them up to cap', async (t) => {
  const r = rwRegistry()
  const ft = await r.begin({ requestId: 'ft', kind: 'finetune', modelId: 'm1' })

  const admitted: string[] = []
  const enqueue = (id: string) =>
    r.begin({ requestId: id, kind: 'completion', modelId: 'm1' }).then((ctx) => {
      admitted.push(id)
      return ctx
    })
  const p1 = enqueue('c-1')
  const p2 = enqueue('c-2')
  const p3 = enqueue('c-3')
  await settle()
  t.alike(admitted, [], 'no reader runs while the writer holds the lane')

  await ft[Symbol.asyncDispose]()
  const c1 = await p1
  const c2 = await p2
  await settle()
  t.alike(admitted, ['c-1', 'c-2'], 'writer release drains readers up to cap=2; the third waits')

  await c1[Symbol.asyncDispose]()
  const c3 = await p3
  t.alike(admitted, ['c-1', 'c-2', 'c-3'], 'freeing a reader admits the third')

  await c2[Symbol.asyncDispose]()
  await c3[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('exclusive: a reader behind a queued writer waits (no barging past the writer)', async (t) => {
  const r = rwRegistry()
  const c1 = await r.begin({ requestId: 'c-1', kind: 'completion', modelId: 'm1' })

  let ftResolved = false
  const ftP = r.begin({ requestId: 'ft', kind: 'finetune', modelId: 'm1' }).then((ctx) => {
    ftResolved = true
    return ctx
  })
  await settle()
  t.is(ftResolved, false, 'writer queues behind the active reader')

  // active(1) < cap(2), but the new reader must still queue behind the writer.
  let c2Resolved = false
  const c2P = r.begin({ requestId: 'c-2', kind: 'completion', modelId: 'm1' }).then((ctx) => {
    c2Resolved = true
    return ctx
  })
  await settle()
  t.is(c2Resolved, false, 'a new reader does not barge past the queued writer')

  await c1[Symbol.asyncDispose]()
  const ft = await ftP
  t.is(ftResolved, true, 'writer admitted after the lane drains')
  t.is(c2Resolved, false, 'reader still waits behind the writer')

  await ft[Symbol.asyncDispose]()
  const c2 = await c2P
  t.is(c2Resolved, true, 'reader admitted after the writer releases')

  await c2[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('exclusive: cancelling a queued writer releases the readers stacked behind it', async (t) => {
  const r = rwRegistry()
  const c1 = await r.begin({ requestId: 'c-1', kind: 'completion', modelId: 'm1' })
  const ftP = r.begin({ requestId: 'ft', kind: 'finetune', modelId: 'm1' })
  await settle()

  let c2Resolved = false
  const c2P = r.begin({ requestId: 'c-2', kind: 'completion', modelId: 'm1' }).then((ctx) => {
    c2Resolved = true
    return ctx
  })
  await settle()
  t.is(c2Resolved, false, 'reader queued behind the writer')

  t.is(r.cancel({ requestId: 'ft' }), 1, 'the queued writer is cancelled')
  const ft = await ftP
  t.is(ft.signal.aborted, true, 'cancelled writer resolves aborted')

  const c2 = await c2P
  t.is(c2Resolved, true, 'reader behind the cancelled writer is admitted')

  await ft[Symbol.asyncDispose]()
  await c1[Symbol.asyncDispose]()
  await c2[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after drain')
})

test('exclusive: cancelAll rejects a queued writer and its trailing readers', async (t) => {
  const r = rwRegistry()
  const holder = await r.begin({ requestId: 'c-1', kind: 'completion', modelId: 'm1' })
  const ftP = r.begin({ requestId: 'ft', kind: 'finetune', modelId: 'm1' }).then(
    () => 'resolved' as const,
    (err) => err
  )
  const c2P = r.begin({ requestId: 'c-2', kind: 'completion', modelId: 'm1' }).then(
    () => 'resolved' as const,
    (err) => err
  )
  await settle()

  await r.cancelAll('modelUnload')

  t.ok((await ftP) instanceof RequestRejectedByPolicyError, 'queued writer rejected on teardown')
  t.ok((await c2P) instanceof RequestRejectedByPolicyError, 'queued reader rejected on teardown')
  t.is(holder.signal.aborted, true, 'the in-flight reader was aborted too')

  await holder[Symbol.asyncDispose]()
  t.is(keyStateProbe(r).__keyStateSize(), 0, 'no KeyState leak after cancelAll teardown')
})

test('withModelDraining: waits for an active request to finish disposing before teardown, and aborts a queued one', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', maxConcurrentPerModel: 1, onOverflow: 'queue' })

  const active = await r.begin({ requestId: 'active', kind: 'completion', modelId: 'm1' })

  // Simulate a native teardown that takes time: the deferred cleanup blocks on
  // a gate we release by hand, so the drain has something real to wait on.
  let cleanupRan = false
  let releaseCleanup = () => {}
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve
  })
  active.scope.defer(async () => {
    await cleanupGate
    cleanupRan = true
  })
  // A real handler unwinds its `await using` on abort; emulate that here.
  active.signal.addEventListener(
    'abort',
    () => {
      void active[Symbol.asyncDispose]()
    },
    { once: true }
  )

  // A second request queues behind the cap-1 lane.
  let queuedResolved = false
  const queuedP = r
    .begin({ requestId: 'queued', kind: 'completion', modelId: 'm1' })
    .then((ctx) => {
      queuedResolved = true
      return ctx
    })
  await settle()
  t.is(queuedResolved, false, 'second request queued behind the active one')

  let teardownRan = false
  let done = false
  const p = r
    .withModelDraining('m1', async () => {
      teardownRan = true
    })
    .then(() => {
      done = true
    })
  await settle()

  // The drain runs before teardown, and can't finish while the active request's
  // gated cleanup is still pending.
  t.is(cleanupRan, false, 'deferred cleanup still blocked')
  t.is(teardownRan, false, 'teardown waits for the drain')
  t.is(done, false, 'withModelDraining still pending')

  releaseCleanup()
  await p
  t.is(cleanupRan, true, 'deferred cleanup completed')
  t.is(teardownRan, true, 'teardown ran after the drain')
  t.is(r.get('active'), null, 'active request disposed and removed')

  // The queued request was resolved into an aborted context, not left hanging.
  const queued = await queuedP
  t.is(queued.signal.aborted, true, 'queued request aborted by the drain')
  await queued[Symbol.asyncDispose]()
  t.is(r.list().length, 0, 'no entries remain once the queued request unwinds')
})

test('withModelDraining: holds an admission barrier during teardown, lifts it after', async (t) => {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', maxConcurrentPerModel: 2, onOverflow: 'queue' })

  let duringAborted: boolean | undefined
  await r.withModelDraining('m1', async () => {
    // Inside teardown the barrier is up: a begin for the model starts aborted,
    // so it can't go active against a model being freed (closes the admission gap).
    const during = await r.begin({ requestId: 'during', kind: 'completion', modelId: 'm1' })
    duringAborted = during.signal.aborted
    await during[Symbol.asyncDispose]()
  })
  t.is(duringAborted, true, 'begin during teardown is aborted')

  // Barrier lifted once teardown resolves: a later reload admits normally.
  const reload = await r.begin({ requestId: 'reload', kind: 'completion', modelId: 'm1' })
  t.is(reload.signal.aborted, false, 'begin after teardown admits normally')
  await reload[Symbol.asyncDispose]()
})

test('withModelDraining: waits for a request whose disposal already started', async (t) => {
  const r = createRequestRegistry()
  const ctx = await r.begin({ requestId: 'a', kind: 'completion', modelId: 'm1' })

  let releaseCleanup = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseCleanup = resolve
  })
  let cleanupDone = false
  ctx.scope.defer(async () => {
    await gate
    cleanupDone = true
  })

  // Start disposal but gate its cleanup: this removes the entry from `entries`
  // (so the drain's scan can't see it) while it is still tearing down.
  const disposeP = ctx[Symbol.asyncDispose]()
  await settle()
  t.is(r.get('a'), null, 'entry left `entries` when disposal started')

  let done = false
  const p = r
    .withModelDraining('m1', async () => {})
    .then(() => {
      done = true
    })
  await settle()
  t.is(done, false, 'drain waits for the in-flight disposal it cannot see in entries')

  releaseCleanup()
  await disposeP
  await p
  t.is(cleanupDone, true, 'gated cleanup finished')
  t.is(done, true, 'resolved only after the in-flight disposal completed')
})
