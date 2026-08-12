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

const { scene } = worldCreateScene({ modelId, prompt, image })
await scene // persist these bytes to revisit this world later

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

A world session is bound to the worker holding that GPU. The world operations
have **no delegated route**, so `loadModel` with a `delegate` and
`mode: 'world'` is rejected at load time rather than failing later on the first
step. Load it on a host with the GPU and omit `delegate`.

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
derived from the model id, and **it lives for exactly one loaded session**: it is
deleted on `unloadModel`, on worker shutdown, and on a failed load. Callers who
want to revisit a world keep the bytes `worldCreateScene` returns and pass them
back as `modelConfig.sceneSrc` on a later load. A supplied `sceneSrc` is copied
into the managed slot; the caller's own file is never touched or deleted.

Creating a world on a session that is already walking **replaces** it and
restarts from the beginning. The replacement is staged: generation writes to a
staging file and is promoted atomically only on success, so a failed or
cancelled generation leaves the previous world intact and walkable rather than
leaving the model with none.

## Concurrency

One job at a time per model. A second `worldStep`, or a `worldCreateScene`
arriving mid-walk, is **rejected rather than queued** — a walk is driven by live
key input, so a backlog of stale keypresses is worse than a refusal the caller
can drop. Drive the next step off the previous one.

## Cancellation granularity

- **`worldStep` is block-granular.** The engine exposes no mid-block abort, so
  the current block finishes internally; cancelling stops frame delivery and
  makes the step reject. It never resolves with a truncated block — the DiT has
  already committed that block to the session history, so the undelivered frames
  are gone and the walk resumes past them. A cancel that lands _after_ the block
  finished legitimately succeeds instead; both outcomes are correct, so handle
  each.
- **`worldCreateScene` is uninterruptible.** The engine takes no abort predicate
  for it. Cancelling suppresses delivery, but the encode runs to completion and
  the model's concurrency slot is held until it does. Await the result before
  unloading.

## Frame size

A block is 9 frames on the first step after a load (decoder warmup) and 12
after, at roughly 14 MB of raw pixels per block. Frames are lossless PNG by
default; set `world.frameJpegQuality` to 1..100 for JPEG (85 is a good value)
whenever frames cross a process or network boundary.
