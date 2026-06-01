# infer-base

Utility primitives for QVAC inference addons.

This package exposes a small set of standalone utilities used by the addon-side runtime: the `QvacResponse` class returned from inference jobs, an `exclusiveRunQueue` for serialized async work, a `getApiDefinition` platform mapper, and a `createJobHandler` lifecycle helper.

## Installation

```bash
npm install @qvac/infer-base
```

## Usage

```javascript
const {
  QvacResponse,
  exclusiveRunQueue,
  getApiDefinition,
  createJobHandler
} = require('@qvac/infer-base')

// Serialize concurrent calls so they run one at a time.
const runExclusive = exclusiveRunQueue()
await runExclusive(async () => { /* serialized work */ })

// Pick the addon API for the current platform ('metal' / 'vulkan' / 'vulkan-32').
const api = getApiDefinition()

// Single-job lifecycle helper for addons that expose one in-flight job at a time.
const jobs = createJobHandler({
  cancel: () => addon.cancel(currentJobId)
})

const response = jobs.start()  // returns a QvacResponse and tracks it as active
jobs.output(chunk)              // forward addon output to the active response
jobs.end(stats)                 // mark the active response finished
jobs.fail(err)                  // mark the active response errored
const active = jobs.active      // current QvacResponse | null

// QvacResponse can also be constructed directly when not using createJobHandler.
const r = new QvacResponse({
  cancelHandler: () => addon.cancel(jobId),
  // Optional: forward the caller-supplied AbortSignal so timeout /
  // crash settles the response without polling. The abort
  // `reason` becomes the response error — pass an Error reason
  // (e.g. `controller.abort(new AddonCrashedError(...))`) to surface
  // a structured failure unchanged.
  signal: opts.signal
})

r.onUpdate(chunk => { /* incremental output */ })
r.onFinish(result => { /* terminal payload */ })
r.onError(err => { /* failure */ })
r.onCancel(() => { /* cancellation */ })

const finalOutput = await r.await()
```

## API

### `QvacResponse`

Response object returned from inference jobs.

```javascript
new QvacResponse({ cancelHandler, signal })
```

- `cancelHandler`: `() => Promise<void>` invoked when `cancel()` is called.
- `signal` (optional): `AbortSignal` typically forwarded from the addon's `model.run(input, { signal })` call. When aborted, the response is failed with the abort `reason` — passed through unchanged when it's an Error, otherwise wrapped in a default `Error('Aborted: ...')`. Callers that want a structured error should attach it as the abort reason (e.g. `controller.abort(new AddonCrashedError(...))`). The abort listener is automatically detached when the response settles, so passing a long-lived / shared signal (e.g. a process-wide crash controller) does not leak listeners.

Listeners and lifecycle:

- `onUpdate(cb)` — fires for each incremental output chunk
- `onFinish(cb)` — fires with the terminal payload
- `onError(cb)` — fires on failure
- `onCancel(cb)` — fires on cancellation
- `await()` — resolves with the final output, or rejects on error
- `iterate()` — async iterator over output chunks; wakes up immediately on output/end/error events instead of polling out the remaining `pollInterval` window. A single pair of EventEmitter listeners is attached for the lifetime of the iterator, so high-frequency token streams do not churn listener registrations.
- `getLatest()` — most recent output chunk
- `cancel()` — invokes `cancelHandler` and emits cancellation

Terminal settlement (`failed()` / `ended()`) is idempotent — repeated calls after the response has already settled are no-ops, so the abort-signal wiring can race with the addon's own settlement without producing double-rejects or double-emits.

### `exclusiveRunQueue()`

Returns a function `(fn) => Promise` that runs `fn` only after every previously queued `fn` has settled. Useful for serializing addon work — for example weight loads or any operation that must not run concurrently.

```javascript
const runExclusive = exclusiveRunQueue()
await runExclusive(async () => addon.loadWeights(params))
```

### `getApiDefinition()`

Returns the graphics API identifier for the current platform: `'metal'`, `'vulkan'`, or `'vulkan-32'`. Falls back to `'vulkan'` on unknown platforms.

### `createJobHandler({ cancel })`

Single-job lifecycle helper that replaces the per-addon `_jobToResponse` Map / `_saveJobToResponseMapping` / `_deleteJobMapping` boilerplate.

- `start(runOpts?)` — creates a new `QvacResponse` and registers it as active; fails any stale active response. `runOpts.signal` is forwarded into the response (see [`QvacResponse`](#qvacresponse)) so the per-call abort signal from `model.run(input, { signal })` settles the job without polling
- `startWith(response)` — registers a pre-built response (e.g. a custom subclass) as active
- `output(data)` — routes output data to the active response (no-op if idle)
- `end(stats?, result?)` — ends the active response, optionally forwarding stats first
- `fail(error)` — fails the active response with an error
- `active` — the current `QvacResponse`, or `null` if idle

## License

Apache-2.0
