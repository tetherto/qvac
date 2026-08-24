# ABot-World interactive worlds

ABot-World is a causal world model: instead of rendering a clip in one call, it
generates video **block by block under per-block key input**, so an application
can walk through a generated world. The SDK exposes it as `mode: 'world'` on the
diffusion plugin, with two operations — `worldCreateScene` builds a world, and
`worldStep` walks it.

```ts
const modelId = await loadModel({
  modelSrc: ABOT_WORLD_0_5B_Q8_0,
  modelType: 'sdcpp-generation',
  modelConfig: {
    mode: 'world',
    taehvModelSrc: ABOT_WORLD_0_5B_LF_VAE,
    t5XxlModelSrc: UMT5_XXL_ENC_Q8_0,
    vaeModelSrc: ABOT_WORLD_0_5B_LF_VAE_F16,
    world: { kvCache: true, frameJpegQuality: 85 }
  }
})

// The world is live on the session once this resolves. Add `returnPack: true`
// only if you want the bytes to persist and revisit this world later.
const { stats } = worldCreateScene({ modelId, prompt, image })
await stats

const { frameStream } = worldStep({ modelId, keys: ['W', 'L'] })
for await (const frame of frameStream) render(frame)
```

## Hardware, and why there is no delegation

The walk session holds the DiT, the pixel decoder and the scene resident.
Measured at the validated 832x480 tier: **16.3 GB steady plus ~2.7 GB transient
at the first block**, so it needs **≥ 20 GB free VRAM on a dedicated GPU** — a
24 GB card is the practical minimum. A co-tenant process holding VRAM will OOM
the first block even though loading succeeded. A **448x256** tier runs on ~6 GB
cards; it is far below interactive frame rates but is what the E2E lane uses.

A world session is bound to the worker holding that GPU, and the world
operations have **no delegated route**. So `loadModel` with a `delegate` and
`mode: 'world'` is settled at load time rather than failing later on the first
step, in one of two ways:

- **`delegate.fallbackToLocal: true`** — the load goes straight to the local
  path, without a round trip to a provider that cannot serve it. This is the
  point of the flag, and local is exactly where a world session works.
- **otherwise** — the load is rejected with an error naming the reason.

Either way, the session ends up on the host holding the GPU. Omitting
`delegate` entirely is the direct way to say that.

## Activation is deferred when there is no world yet

Every other model type loads its weights inside `loadModel`. A world session
cannot always do that, because the walk reads a scene pack that may not exist
yet — the caller is about to create it.

- **`sceneSrc` supplied** — the session activates during `loadModel`, so a bad
  pack or an oversubscribed GPU fails fast like any other model.
- **no `sceneSrc`** — `loadModel` returns without activating, and the session
  activates on the first `worldStep` after a scene exists. Stepping before then
  fails with a structured error telling you to call `worldCreateScene`.

## Scene ownership and replacement

A scene pack (~10 MB `.safetensors`) is prompt embeddings plus first-frame
latents, and its resolution is baked in — create one pack per resolution.

The SDK owns the pack on disk. It lives under `~/.qvac/world-scenes/` at a path
derived from the model id **and a per-session token**, and **it lives for exactly
one loaded session**: it is deleted on `unloadModel`, on worker shutdown, and on
a failed load. The per-session token is what stops two workers on the same model
from writing each other's world, and stops a pack orphaned by a crashed session
being adopted by the next load as a world the caller never built.

Because the pack is session-scoped, persisting a world is explicit. Pass
`returnPack: true` to `worldCreateScene`, save the bytes it returns, and pass
that file back as `modelConfig.sceneSrc` on a later load. Without it the response
carries no pack at all — 10+ MB, a third larger again as base64, that the
create-then-walk-now flow never reads. `sceneSrc` takes a path or URL; a supplied
pack is copied into the managed slot and the caller's own file is never touched
or deleted.

Creating a world on a session that already has one **replaces** it and restarts
the walk from the beginning. The replacement is staged: generation writes to a
staging file and is promoted atomically only on success, so a generation that
fails **before promotion** leaves the previous world intact and walkable rather
than leaving the model with none.

Once the promotion rename lands, the previous world is gone — that is what
replacement means. A cancel accepted after that point still stops delivery and
rejects the request, but it does not roll the new world back: the contract is
that delivery stops, not that the encode is undone. The next `worldStep`
activates the world that was promoted.

## Concurrency

One job at a time per model. A second `worldStep`, or a `worldCreateScene`
arriving while a step is still in flight, is **rejected rather than queued** — a
walk is driven by live
key input, so a backlog of stale keypresses is worse than a refusal the caller
can drop. Drive the next step off the previous one.

## Cancellation granularity

- **`worldStep` is block-granular.** The engine exposes no mid-block abort, so
  the current block finishes internally; cancelling stops frame delivery and
  makes the step reject with `InferenceCancelledError`. It never resolves with a
  truncated block: the undelivered frames are gone, so reporting `done` would
  dress a silent gap up as success.
- **A cancelled step is terminal for the native session**, exactly like a failed
  one: the engine's RNG and history cannot be resumed either way. Native compute
  for the block may run to completion, but the history it advanced is discarded
  along with the session. The SDK drops the session for you and the **next
  `worldStep` rebuilds it** from the same promoted pack, so no
  `unloadModel`/`loadModel` cycle is needed — the walk restarts from the world's
  beginning rather than resuming past the frames you did not receive.
- **Breaking out of `frameStream` does not stop anything.** The client pumps the
  RPC stream independently of the generator you iterate, so `break` closes only
  your local projection: the block finishes, and `frames` and `stats` still
  resolve normally. To actually stop delivery, call `cancel({ requestId })`.
  A genuine transport disconnect has the same effect as a cancel — the server
  sees the stream end early, and because that leaves the session advanced past
  frames nobody received, it is torn down and rebuilt on the next step.
- **`worldCreateScene` is uninterruptible.** The engine takes no abort predicate
  for it. Cancelling suppresses delivery, but the encode runs to completion and
  the model's concurrency slot is held until it does. Await the result before
  unloading.

## Progress is one summary per block, after the frames

`worldStep` exposes a `progressStream` alongside `frameStream`, matching `video`
and `diffusion`. It is **not** mid-block liveness and cannot be: the engine runs
the block to completion, delivers every frame, and only then fires its progress
callback. So it yields exactly once per step, at the end, carrying the block's
final delivered frame count and elapsed time. Use it to report what a block did.
A "still working" indicator for the seconds a block takes has to come from your
own timer, or from an addon change.

## Recovering a session whose teardown failed

If the native `unload()` rejects, the addon wrapper still believes it is loaded,
so the session is marked unusable and later steps fail with
`ModelNotLoadedError` rather than walking a dead world. Recovery is
**`unloadModel` then `loadModel`, in that order**:

```ts
await unloadModel({ modelId }).catch(() => {}) // may throw again; the id is freed either way
const modelId = await loadModel({ modelSrc: ABOT_WORLD_0_5B_Q8_0, ... })
```

Calling `loadModel` on its own does not recover it. `loadModel` returns success
without doing any work while the id is still registered, so it hands back the
same torn session. `unloadModel` unregisters before it tears down, so it clears
the id even when the native unload throws a second time.

## Frame size

**At the default `world.numFramePerBlock`**, a block is 9 frames on the first
step after a load (decoder warmup) and 12 after, at roughly 14 MB of raw pixels
per block at 832x480. All three numbers move with the block shape: raising
`world.numFramePerBlock` raises the frame count and the byte count with it, and
the resolution you passed to `worldCreateScene` scales the bytes again. Read the
count off `stats.frames` rather than assuming 9/12.

Frames are lossless PNG by default; set `world.frameJpegQuality` to 1..100 for
JPEG (85 is a good value) whenever frames cross a process or network boundary.
