import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import WorldStableDiffusion from '@qvac/diffusion-cpp/world'
import type { WorldConfig } from '@qvac/diffusion-cpp/world'
import type QvacLogger from '@qvac/logging'
import { getEngineLogger } from '@/logging/index'
import { getModel, getModelEntry } from '@/runtime/model-registry'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'
import { getCacheDir, generateShortHash, readImageDimensions } from '@/utils/index'
import {
  InferenceCancelledError,
  ModelLoadFailedError,
  ModelNotLoadedError,
  ModelOperationNotSupportedError,
  PluginRequestValidationFailedError
} from '@/errors/index'
import { ModelType } from '@/schemas/index'
import type {
  WorldSceneRequest,
  WorldSceneStats,
  WorldSceneStreamResponse,
  WorldStepRequest,
  WorldStepStats,
  WorldStepStreamResponse
} from '@/schemas/sdcpp-config'

// A step is ~1.8s and a scene is bounded by its encoder loads, so anything past
// this means the native job is not progressing. Warn only — see settleInFlight.
const INFLIGHT_WARN_MS = 120_000

// A pack is ~10 MB at 832x480 and scales with pixel area; 128 MB is far above
// any real resolution and well under what would hurt a worker to hold, base64
// included. A pack past it means something went wrong natively, not a bigger
// world.
const MAX_SCENE_PACK_BYTES = 128 * 1024 * 1024

/**
 * Ceiling on the first frame's DECLARED pixel count, read from its header before
 * anything decodes it.
 *
 * 8192x8192. Sized off what people actually send, not off the output: the frame
 * is cover-scaled and cropped, so a phone photo is a perfectly reasonable source
 * for an 832x480 world, and a 12 MP camera image (4000x3000) must not be
 * refused. This bounds the decode at roughly 200 MB while still refusing a
 * gigapixel bomb by more than an order of magnitude.
 */
const MAX_SCENE_IMAGE_PIXELS = 8192 * 8192

/**
 * Ceiling on ONE block of decoded frames, held in memory at once.
 *
 * The per-axis and total-pixel limits bound a single frame; `numFramePerBlock`
 * bounds how many. Neither alone bounds the product, and the product is what is
 * allocated: at the 1920x1088 ceiling a frame is ~6 MiB, so the 64-frame maximum
 * would reach ~1.49 GiB. Enforced where both numbers are known, which is scene
 * creation — the resolution arrives per request, the block shape at load.
 */
const MAX_BLOCK_BYTES = 512 * 1024 * 1024

/** Frames a block delivers: ~4x the configured latent frames, 12 at the default of 3. */
function projectedFramesPerBlock(numFramePerBlock: number | undefined): number {
  const latent = numFramePerBlock === undefined || numFramePerBlock === 0 ? 3 : numFramePerBlock
  return latent * 4
}

interface WorldSessionArgs {
  modelId: string
  files: { model: string; taehv: string; scene: string }
  config: WorldConfig
  /** umT5-XXL and Wan2.2 VAE, resolved at load; scene creation needs both. */
  encoders: { t5?: string | undefined; vae?: string | undefined }
  /** Resolved `modelConfig.sceneSrc`, copied over the managed pack at load. */
  seedScenePath?: string | undefined
  logger: QvacLogger
  /**
   * The native session to drive. Constructed here when omitted, which is what
   * every caller does; injecting one is how the teardown and cancellation paths
   * are exercised, since the addon calls the engine C API directly and offers
   * no substitution point of its own.
   */
  world?: NativeWorldSession
  /**
   * Ceiling for a generated pack, defaulting to `MAX_SCENE_PACK_BYTES`.
   * Overridable for the same reason as `world` above: the real limit is far
   * larger than anything a test should write to disk.
   */
  maxScenePackBytes?: number
}

/** The part of `WorldStableDiffusion` this module actually uses. */
export type NativeWorldSession = Pick<
  WorldStableDiffusion,
  'load' | 'unload' | 'step' | 'createScene' | 'cancel'
>

/**
 * All `run()` needs of a job handle is "tell me when it is over". Kept
 * structural rather than importing `QvacResponse`: the addon can resolve a
 * different copy of `@qvac/infer-base` than the SDK does, and a nominal type
 * would make this file fail to compile on the dependency layout rather than on
 * anything real.
 */
interface SettleableResponse {
  await(): Promise<unknown>
}

export interface WorldSession {
  load(force?: boolean): Promise<void>
  unload(): Promise<void>
  readonly scenePath: string
  /** Where a replacement world is generated before it is allowed to take over. */
  readonly stagingScenePath: string
  readonly encoders: { t5?: string | undefined; vae?: string | undefined }
  /**
   * `world.numFramePerBlock` as configured, or undefined for the engine default.
   * Exposed because the block's memory cost is count x resolution, and only the
   * scene op knows the resolution.
   */
  readonly numFramePerBlock: number | undefined
  ensureActivated(): Promise<void>
  deactivate(): Promise<void>
  /**
   * Promote a freshly generated pack, returning its bytes only when asked. The
   * previous world is replaced only here, and the read is part of the same
   * locked step so a concurrent unload cannot delete the pack between the two.
   */
  promoteStagedScene(readBytes: boolean): Promise<Buffer | undefined>
  /** Drop a failed generation, leaving the previous world usable. */
  discardStagedScene(): Promise<void>
  /** Wait for native work to finish. See the note on `settleInFlight`. */
  settle(): Promise<void>
  run<T extends SettleableResponse>(start: () => Promise<T>): Promise<T>
  step: WorldStableDiffusion['step']
  createScene: WorldStableDiffusion['createScene']
  cancel(): Promise<void>
}

const worldSessions = new WeakSet<object>()

/**
 * Server-side path for one session's scene pack. Derived from a hash of the
 * caller-supplied `modelId` rather than the id itself, so the id can never
 * steer the write.
 *
 * Deliberately unique per call, not per `modelId`. A pack keyed only on the
 * model id is shared state across every process using the same cache dir: two
 * workers loading the same model would write each other's world, and a pack
 * orphaned by a crashed session would be adopted by the next `load()` as if the
 * caller had built it — walking a world they never created. Neither is
 * detectable from inside the session.
 *
 * Uniqueness costs nothing here because the managed pack is not a cache: it
 * lives for exactly one loaded session, and callers who want to revisit a world
 * pass the bytes back as `modelConfig.sceneSrc`. The one invariant that does
 * matter — `createScene` writes exactly where the native session was
 * constructed to read — comes from calling this ONCE per session and storing
 * the result in `files.scene`, not from the path being reproducible.
 *
 * No garbage collection, deliberately. `unload()` removes the pack, and so does
 * worker shutdown, so only a crash or SIGKILL leaks one — bounded at roughly
 * 10 MB per lost session, and never adopted by a later run because the name is
 * unique. The obvious mtime-based sweep is NOT safe here: a pack is written once
 * at promotion and never touched again, so a session walking for hours looks
 * exactly as old as an orphan, and ~/.qvac is shared across worker processes.
 * Doing this properly needs a liveness marker like the one
 * `planAutoCacheEvictions` gets from `activeCachePaths` in
 * `server/bare/ops/kv-cache-retention.ts`. Tracked as a follow-up rather than
 * guessed at here.
 */
export function worldScenePath(modelId: string): string {
  const session = generateShortHash(generateRandomRequestId())
  return path.join(
    getCacheDir('world-scenes'),
    `${generateShortHash(modelId)}-${session}.safetensors`
  )
}

/**
 * Wraps `WorldStableDiffusion` so it satisfies the plugin `load()` contract.
 *
 * Two things make the raw addon unusable as a plugin model. First, `load()`
 * reads the scene pack, which does not exist yet when the caller intends to
 * build a world with `worldCreateScene` — so activation is deferred until a
 * scene is present. Second, the addon's `unload()` is synchronous down to a
 * native thread join, so calling it while a job runs blocks the worker's event
 * loop for the rest of that job (a walk block, or a whole scene encode plus its
 * ~6.9 GB of encoder loads). We therefore track the in-flight job and wait for
 * it before tearing down.
 */
export function createWorldSession(args: WorldSessionArgs): WorldSession {
  const { modelId, files, config, encoders, seedScenePath, logger } = args
  const maxScenePackBytes = args.maxScenePackBytes ?? MAX_SCENE_PACK_BYTES
  const world: NativeWorldSession =
    args.world ?? new WorldStableDiffusion({ files, config, logger, opts: { stats: true } })
  const stagingScenePath = `${files.scene}.staging`

  let activated = false
  let inFlight: Promise<unknown> | null = null
  let torn = false
  let lockTail: Promise<void> = Promise.resolve()

  /**
   * Serialises everything that touches the native session or its pack files
   * against teardown. `unloadModel` is a plain RPC — it does not pass through
   * the request registry, so nothing else stops it landing between this
   * session's own awaits. Same promise-chain idiom as `withCacheStateLock` in
   * llamacpp-completion/ops/kv-cache-session.ts.
   */
  async function withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = lockTail
    let releaseLock = () => {}
    lockTail = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      releaseLock()
    }
  }

  /**
   * `torn` is set synchronously by `unload()` before it awaits anything, so a
   * caller that has not yet yielded cannot dispatch into a session that is
   * already being torn down.
   */
  function assertLive(): void {
    if (torn) throw new ModelNotLoadedError(modelId)
  }

  function hasScene(): boolean {
    return fs.existsSync(files.scene)
  }

  // `force` makes an already-absent pack a no-op, so anything reaching the
  // catch is a real failure: teardown must not fail over it, but swallowing it
  // silently would make an ephemeral-scene leak invisible.
  async function removeIfPresent(target: string): Promise<void> {
    try {
      await fsPromises.rm(target, { force: true })
    } catch (error) {
      logger.warn(
        `Could not remove world scene pack "${target}" for "${modelId}": ` +
          `${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async function activate(): Promise<void> {
    await world.load()
    activated = true
  }

  /**
   * Native teardown runs synchronously down to a thread join, so calling it
   * while a job is running blocks the worker's event loop — every model and
   * every RPC on it — until that job finishes on its own. Waiting here costs
   * the same wall-clock and keeps the loop free.
   *
   * Deliberately unbounded. A deadline would have to either give up (leaking
   * the session) or tear down anyway, and tearing down early is precisely the
   * freeze this exists to avoid. The native job always terminates.
   */
  async function settleInFlight(): Promise<void> {
    if (!inFlight) return
    const timer = setTimeout(() => {
      logger.warn(
        `World job on "${modelId}" still running after ${INFLIGHT_WARN_MS}ms; teardown is waiting for it to finish`
      )
    }, INFLIGHT_WARN_MS)
    try {
      await inFlight
    } catch {
      // A failed job is still a finished job — that is all we need here.
    } finally {
      clearTimeout(timer)
    }
  }

  const session: WorldSession = {
    scenePath: files.scene,
    stagingScenePath,
    encoders,
    numFramePerBlock:
      typeof config.numFramePerBlock === 'number' ? config.numFramePerBlock : undefined,
    settle: settleInFlight,

    // Only here does a new world replace the old one. `rename` within the same
    // directory is atomic, so a reader never sees a half-written pack and a
    // crash mid-generation cannot leave the model pointing at one.
    //
    // Promotion and the read that follows it are one locked step, and the bytes
    // come back from here rather than the caller re-reading `scenePath`: an
    // `unloadModel` landing between the two deletes the pack, which would turn
    // a finished world into an ENOENT with no explanation.
    async promoteStagedScene(readBytes) {
      return withSessionLock(async () => {
        assertLive()
        // Sized BEFORE promotion, so an implausible pack cannot replace the
        // world the caller already had — and, when the bytes were asked for,
        // cannot be base64'd into ~4/3 of its size in worker memory either.
        const { size } = await fsPromises.stat(stagingScenePath)
        if (size > maxScenePackBytes) {
          throw new PluginRequestValidationFailedError(
            'worldSceneStream',
            `Generated world scene pack is ${size} bytes, over the ${maxScenePackBytes}-byte ceiling. ` +
              'The previous world was left in place; lower worldCreateScene width/height and create it again.'
          )
        }
        // Read BEFORE the rename, so the rename is the last thing that can fail
        // and the only thing that commits. Reading after it meant a failed read
        // — ENOENT, EIO, or simply not enough memory for a large pack — handed
        // the caller an error against a world that had already been replaced,
        // with the previous one gone and no way back.
        //
        // 'buffer' picks the Buffer overload; the bare-arg form is typed
        // `string | Buffer`, which the pack is never read as text.
        const bytes = readBytes ? await fsPromises.readFile(stagingScenePath, 'buffer') : undefined
        await fsPromises.rename(stagingScenePath, files.scene)
        return bytes
      })
    },

    // Generation failed: drop the staged file and leave the previous pack in
    // place, so the next step re-activates the world the caller already had
    // rather than finding the model worldless.
    async discardStagedScene() {
      // No liveness check: dropping a staged file is safe whether or not the
      // session survived, and a discard that threw would mask the failure that
      // triggered it.
      await withSessionLock(() => removeIfPresent(stagingScenePath))
    },

    // Eager when a scene pack is already present, so a bad pack or an
    // oversubscribed GPU fails at loadModel like every other model type.
    // Deferred otherwise — the caller is going to build the world first.
    async load() {
      // The native session reads the pack from the single path it was
      // constructed with, so a caller-supplied pack is copied into that slot
      // rather than pointed at — unconditionally, so changing sceneSrc between
      // loads of the same modelId cannot leave a stale world in place.
      if (seedScenePath) {
        // The same ceiling `promoteStagedScene` applies to a pack we generate.
        // Both paths end at `files.scene` and are loaded by the same native
        // session, so capping only the generated one just means an oversized
        // pack has to arrive via `sceneSrc` instead. Checked before the copy, so
        // an implausible file is refused rather than duplicated onto disk first.
        const seedStat = await fsPromises.stat(seedScenePath)
        // A directory or device node stats fine and would fail later inside
        // copyFile with a bare errno. Say what is wrong while we still know.
        if (!seedStat.isFile()) {
          throw new ModelLoadFailedError(
            'modelConfig.sceneSrc must be a file. Scene packs are the .safetensors ' +
              'files worldCreateScene produces.'
          )
        }
        if (seedStat.size > maxScenePackBytes) {
          throw new ModelLoadFailedError(
            `modelConfig.sceneSrc is ${seedStat.size} bytes, over the ` +
              `${maxScenePackBytes}-byte scene-pack ceiling. Scene packs are produced ` +
              'by worldCreateScene; a file this large is not one.'
          )
        }
        try {
          await fsPromises.copyFile(seedScenePath, files.scene)
          // Re-check what actually landed rather than trusting the pre-copy
          // stat: the two are separate syscalls, so the source can change in
          // between and the ceiling would have been measured on a file we did
          // not copy. This is the size that matters — it is the one the native
          // session will load.
          const { size: copiedSize } = await fsPromises.stat(files.scene)
          if (copiedSize > maxScenePackBytes) {
            throw new ModelLoadFailedError(
              `modelConfig.sceneSrc copied as ${copiedSize} bytes, over the ` +
                `${maxScenePackBytes}-byte scene-pack ceiling.`
            )
          }
        } catch (error) {
          // A copy that died partway leaves a truncated pack that `hasScene()`
          // would happily treat as a world — and so does an oversized one we
          // just rejected. Drop it so the failure is the load error, not a
          // corrupt or outsized world discovered on the first step.
          await removeIfPresent(files.scene)
          throw error
        }
      }
      if (!hasScene()) {
        logger.info(
          'No scene pack yet — the walk session will activate on the first step after worldCreateScene'
        )
        return
      }
      try {
        await activate()
      } catch (error) {
        // The model never registers when load throws, so nothing else will ever
        // come back to clean this up. The pack is our own copy — the caller's
        // `sceneSrc` original is untouched.
        await removeIfPresent(files.scene)
        throw error
      }
    },

    async ensureActivated() {
      assertLive()
      if (activated) return
      await withSessionLock(async () => {
        assertLive()
        if (activated) return
        if (!hasScene()) {
          // A request-time precondition on a model that loaded fine, so this is
          // a bad request rather than a load failure.
          throw new PluginRequestValidationFailedError(
            'worldStepStream',
            `No world exists for model "${modelId}". Create one with worldCreateScene({ modelId, prompt, image }), ` +
              'or load the model with modelConfig.sceneSrc pointing at an existing scene pack.'
          )
        }
        await activate()
      })
    },

    // The native session caches the scene it was activated with, and `load()`
    // is a no-op once loaded — so a rewritten pack would be ignored and the
    // walk would silently continue in the old world. Drop the session first.
    async deactivate() {
      if (!activated) return
      await withSessionLock(async () => {
        if (!activated) return
        await settleInFlight()
        try {
          await world.unload()
          activated = false
        } catch (error) {
          // A rejecting native unload is NOT recoverable by clearing our own
          // bookkeeping, and clearing it is actively harmful. The addon wrapper
          // sets `addon = null` and `configLoaded = false` only AFTER its
          // `addon.unload()` resolves (diffusion-cpp/src/world.ts), so a
          // rejection leaves it still believing it is loaded. If we then said
          // `activated = false`, the next `ensureActivated()` would call
          // `world.load()`, hit its `if (configLoaded) return` guard, no-op, and
          // report an active session sitting on native state we already tried to
          // destroy.
          //
          // Mark the session unusable instead. `assertLive` then fails every
          // later call with ModelNotLoadedError, which tells the caller the truth
          // — reload the model — rather than silently walking a dead world.
          torn = true
          // Spell out the recovery, because the obvious one does not work:
          // `loadModel` returns success without doing anything while the id is
          // still registered (plugins/ops/load-model.ts), so a direct reload
          // hands back this same torn session. `unloadModel` first — it
          // unregisters before teardown, so it clears the id even when the
          // native unload throws again.
          logger.error(
            `World session teardown failed for "${modelId}"; the session is unusable. ` +
              'Recover with unloadModel({ modelId }) THEN loadModel(...) — loading ' +
              'again on its own is a no-op while the id stays registered. Cause: ' +
              `${error instanceof Error ? error.message : String(error)}`
          )
          throw error
        }
      })
    },

    // Tracks the job for `unload()` to wait on. It must follow the response to
    // its terminal state, not just the dispatch: `step()` and `createScene()`
    // resolve as soon as the native scheduler admits the job, while the block
    // or encode this guard exists for runs on well after that.
    //
    // Registration happens at dispatch, before the first await, because the
    // admission itself is part of the job: `await start()` yields the event
    // loop, and a teardown landing in that window would find `inFlight` empty
    // and take the native session down underneath a job the scheduler had
    // already accepted.
    async run(start) {
      assertLive()
      // `start` is typed as a thunk, but this method is only reachable through
      // `getModel(modelId)`, which is untyped — and `ops/diffusion.ts` calls
      // `model.run({ prompt, ... })` with NO model-type guard (unlike
      // `asVideoModel` / `asUpscalerModel` in its sibling ops). A diffusion
      // request aimed at a world model therefore lands here with an options
      // object. Refuse it BEFORE `inFlight` is touched: assigning the guard
      // first and failing afterwards would leave an already-settled promise in
      // it, making `settleInFlight()` a no-op while a native block is still
      // running — and teardown would then enter the addon's synchronous unload
      // mid-job and freeze the worker's event loop for every model on it.
      if (typeof start !== 'function') {
        throw new ModelOperationNotSupportedError(
          modelId,
          ModelType.sdcppGeneration,
          'diffusion',
          ['worldStep', 'worldCreateScene'],
          []
        )
      }
      const dispatch = (async () => start())()
      // A dispatch that rejects is a finished job as far as teardown cares, so
      // both arms settle the guard. Failures still reach the caller — from the
      // returned promise here, and from `response.iterate()` after it.
      const settled: Promise<void> = dispatch.then(
        (response) =>
          response.await().then(
            () => {},
            () => {}
          ),
        () => {}
      )
      inFlight = settled
      void settled.finally(() => {
        if (inFlight === settled) inFlight = null
      })
      return dispatch
    },

    step: (keys) => world.step(keys),
    createScene: (params) => world.createScene(params),
    cancel: () => world.cancel(),

    async unload() {
      // Set before the first await so `assertLive` can refuse new work from a
      // caller that has not yielded yet. Taking the lock is not enough on its
      // own: acquiring it is itself an await.
      torn = true
      await withSessionLock(async () => {
        await settleInFlight()
        try {
          await world.unload()
        } finally {
          // In a `finally` because this is the ONLY chance to remove the pack. A
          // rejecting native unload used to skip both removals, and nothing ever
          // comes back: `unload-model.ts` unregisters the entry before calling
          // this, and `unloadAllModels` swallows the error and drops the entry
          // too. With per-session names and no GC by design, that orphan is
          // never adopted and never swept — so repeated load/unload cycles would
          // accumulate ~10 MB each, unbounded.
          activated = false
          await removeIfPresent(files.scene)
          await removeIfPresent(stagingScenePath)
        }
      })
    }
  }

  worldSessions.add(session)
  return session
}

function asWorldSession(model: unknown, modelId: string, operation: string): WorldSession {
  if (model !== null && typeof model === 'object' && worldSessions.has(model)) {
    return model as WorldSession
  }

  const entry = getModelEntry(modelId)
  const modelType = entry ? entry.local.modelType : ModelType.sdcppGeneration
  throw new ModelOperationNotSupportedError(modelId, modelType, operation, ['diffusion'], [])
}

// Runtime stats hang off the response object rather than its type, the same way
// ops/upscale.ts and ops/video.ts read them.
interface StepResponseWithStats {
  stats?: WorldStepStats
}

interface SceneResponseWithStats {
  stats?: WorldSceneStats
}

export async function* worldStep(
  request: WorldStepRequest
): AsyncGenerator<WorldStepStreamResponse> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRandomRequestId(),
    kind: 'world',
    modelId: request.modelId
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)

  // Before ANYTHING touches the session. A cancel that landed before `begin(...)`
  // resolved makes the registry skip admission, so this context holds no world
  // slot and another step may legitimately own the lane right now. Everything
  // below reaches across to that owner: `ensureActivated()` can re-activate a
  // session it is using, and `onAbort` fires `session.cancel()`, which is a
  // MODEL-WIDE native cancel — it would kill the owner's in-flight block, not
  // ours, since we have none. The later pre-dispatch check cannot help; by then
  // the listener has already run.
  if (ctx.signal.aborted) {
    throw new InferenceCancelledError(ctx.requestId)
  }

  const session = asWorldSession(getModel(request.modelId), request.modelId, 'worldStep')
  await session.ensureActivated()

  // Block-granular by design: the engine exposes no mid-block abort, so this
  // stops frame delivery and makes the step reject rather than resolve with a
  // silently truncated block.
  const onAbort = () => {
    session.cancel().catch((err: unknown) => {
      requestLogger.warn(
        `[cancel] world cancel rejected for modelId=${request.modelId}: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  if (ctx.signal.aborted) onAbort()
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener('abort', onAbort)
  })

  // An abort can land while `ensureActivated()` is still running. `onAbort` has
  // then already fired, but the native cancel flag it sets is CLEARED by
  // `processWalkStep()` when the next block begins — so dispatching now would
  // run a full block, advance the session history, and deliver none of it. The
  // caller would see a rejection while the world silently moved on. Refuse
  // before dispatch instead.
  if (ctx.signal.aborted) {
    throw new InferenceCancelledError(ctx.requestId)
  }

  // The dispatch sits INSIDE the guard, not in front of it: `step()` rejects at
  // admission too (`runStep` throwing on VRAM exhaustion, the addon's busy
  // guard), and the addon's `_stepInternal` fails the native job on its way
  // out. A rejection in front of the `try` would skip both `settle()` and the
  // terminal teardown below and leave `activated` true over a dead session —
  // the exact wedge that teardown exists to prevent. `worldCreateScene` puts
  // its dispatch inside its guard for the same reason.
  let response: StepResponseWithStats & { iterate(): AsyncIterable<unknown> }
  let frameIndex = 0
  // Set only when `iterate()` runs to its own end. Every other way out of the
  // block below leaves the native session advanced past frames the caller never
  // saw, which is the same hazard as a cancel and needs the same teardown. A
  // consumer that stops early — a dropped transport, a `break`, an explicit
  // `.return()` on the generator — unwinds through `finally` as a RETURN
  // completion: `catch` does not run and `ctx.signal.aborted` is false, so
  // neither of the other two flags can stand in for this one.
  let drained = false

  try {
    response = (await session.run(() =>
      session.step(request.keys ?? [])
    )) as unknown as StepResponseWithStats & { iterate(): AsyncIterable<unknown> }
    for await (const chunk of response.iterate()) {
      if (ctx.signal.aborted) break
      if (chunk instanceof Uint8Array) {
        yield {
          type: 'worldStepStream',
          data: Buffer.from(chunk).toString('base64'),
          frameIndex: frameIndex++
        }
      } else if (typeof chunk === 'string') {
        // The addon emits `{"step":N,"frames":M,"elapsed_ms":T}` ONCE per block,
        // after every frame has been delivered — WorldSessionModel.cpp runs the
        // step to completion, loops the frames out, then fires the callback. So
        // this is an end-of-block summary, not the mid-block liveness it would
        // be if the engine ticked per denoise step. Forwarded anyway, for the
        // same reason ops/video.ts and ops/diffusion.ts forward theirs: the wire
        // shape stays identical across the three, and if the engine ever ticks
        // during a block this needs no change to carry it.
        //
        // `frames` maps onto `totalSteps` rather than a field of its own so the
        // wire shape stays identical to its two siblings — the engine counts a
        // world block's progress in decoded frames, not in sampler steps.
        try {
          const tick = JSON.parse(chunk) as Record<string, unknown>
          if ('step' in tick) {
            yield {
              type: 'worldStepStream',
              step: tick['step'] as number,
              totalSteps: tick['frames'] as number,
              elapsedMs: tick['elapsed_ms'] as number
            }
          }
        } catch {
          // Non-JSON string output — skip, as the sibling ops do.
        }
      }
    }
    drained = !ctx.signal.aborted
  } catch (error) {
    // Native cancellation surfaces as the addon's own `Diffusion/Cancelled`
    // error out of `iterate()`. Rethrowing it raw hands the client a generic RPC
    // error for what this API promises as a typed cancellation — and the
    // conversion below the try is unreachable once we throw from here. Only an
    // aborted request is relabelled; every other failure keeps its own error.
    // `finally` still runs before this propagates, so the settle and teardown
    // happen first either way.
    if (ctx.signal.aborted) {
      throw new InferenceCancelledError(ctx.requestId, {}, error)
    }
    throw error
  } finally {
    // Cancel is block-granular, so the DiT keeps going after we stop reading.
    // Hold the model's slot until it stops, or the next step is admitted into a
    // session the addon will reject as busy. Runs on early consumer exit too.
    await session.settle()

    // Both a failure AND a cancellation are terminal for the native session.
    // The addon contract is explicit that the engine's RNG/history cannot be
    // resumed after either — of cancellation it says "Treat it like any failed
    // step: reload the session" — so leaving `activated` true would make every
    // later step dispatch into dead state and surface opaque native errors,
    // recoverable only by unloadModel + loadModel and a re-resolve of the
    // artifacts. Dropping it here lets the next step rebuild transparently from
    // the same promoted pack.
    //
    // A cancel does not reach the `catch` above: the loop breaks on the abort
    // flag rather than throwing, so the abort has to be tested here too. And an
    // early consumer exit reaches neither, which is what `drained` covers.
    if (!drained) {
      try {
        await session.deactivate()
      } catch (teardownError) {
        // Never mask the failure that got us here.
        requestLogger.warn(
          `World session teardown failed for modelId=${request.modelId} after a terminal step: ` +
            `${teardownError instanceof Error ? teardownError.message : String(teardownError)}`
        )
      }
    }
  }

  // A cancelled block must not be reported as a finished one. Native compute for
  // the block may well finish, but its history is discarded with the session in
  // the teardown above, so the frames we did not deliver are gone for good —
  // yielding `done` here would hand the caller a silent gap dressed up as
  // success. The next step rebuilds from the promoted pack and the walk restarts
  // from the world's beginning. The addon makes the step itself reject for the
  // same reason; this covers the race where we stop iterating before that
  // rejection lands.
  if (ctx.signal.aborted) {
    throw new InferenceCancelledError(ctx.requestId)
  }

  const { stats } = response
  yield {
    type: 'worldStepStream',
    done: true,
    ...(stats && { stats })
  }
}

export async function* worldCreateScene(
  request: WorldSceneRequest
): AsyncGenerator<WorldSceneStreamResponse> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateRandomRequestId(),
    kind: 'world',
    modelId: request.modelId
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)
  const session = asWorldSession(getModel(request.modelId), request.modelId, 'worldCreateScene')

  const { t5, vae } = session.encoders
  if (!t5 || !vae) {
    throw new PluginRequestValidationFailedError(
      'worldSceneStream',
      'Creating a world requires the prompt and image encoders. Load the model with ' +
        'modelConfig.t5XxlModelSrc (umT5-XXL) and modelConfig.vaeModelSrc (Wan2.2 VAE).'
    )
  }

  // Sits HERE, with the other pure preconditions, and not further down: every
  // statement below `deactivate()` costs the caller their live session, and a
  // request rejected on its own input must not be what takes it. Nothing in this
  // check needs the session.
  //
  // The base64 ceiling on `image` bounds what crosses the WIRE, not what the
  // decoder allocates — wildly different numbers for a compressed format. A
  // 1.5 MB PNG of uniform scanlines can declare 40000x40000: 1.6 gigapixels, and
  // roughly 4.8 GB in a single native allocation, all of it before the
  // cover-scale and crop that would have brought it down to width x height.
  // `readImageDimensions` is a header read — big-endian IHDR for PNG, the first
  // SOFx segment for JPEG — so this costs microseconds and happens before any of
  // it.
  //
  // Only enforced when the header is actually readable. The addon documents
  // PNG/JPEG, which is exactly what this reads, and refusing everything else here
  // would reject formats the native decoder may accept today.
  // Count x resolution is what actually gets allocated, and neither ceiling
  // bounds the product on its own. Checked here because this is the only point
  // where both are known: the block shape came from modelConfig at load, the
  // resolution arrives with this request.
  const blockWidth = request.width ?? 832
  const blockHeight = request.height ?? 480
  const blockBytes =
    projectedFramesPerBlock(session.numFramePerBlock) * blockWidth * blockHeight * 3
  if (blockBytes > MAX_BLOCK_BYTES) {
    throw new PluginRequestValidationFailedError(
      'worldSceneStream',
      `A ${blockWidth}x${blockHeight} world at world.numFramePerBlock=` +
        `${session.numFramePerBlock ?? 3} would hold ${blockBytes} bytes of decoded ` +
        `frames per block, over the ${MAX_BLOCK_BYTES}-byte ceiling. Lower the ` +
        'resolution, lower world.numFramePerBlock, or both.'
    )
  }

  const image = Buffer.from(request.image, 'base64')
  const declared = readImageDimensions(image)
  if (!declared) {
    // Fail CLOSED. The sender picks the format, so treating "cannot size this"
    // as "allow it" makes the ceiling below trivially skippable — deliver the
    // same bomb as a BMP and nothing checks it. The schema documents PNG/JPEG,
    // so this refuses exactly what it already says it does not accept.
    throw new PluginRequestValidationFailedError(
      'worldSceneStream',
      'The first-frame image is not a readable PNG or JPEG. Its dimensions have ' +
        'to be checked before anything decodes it, so a frame whose header ' +
        'cannot be read is refused rather than allocated.'
    )
  }
  if (declared.width * declared.height > MAX_SCENE_IMAGE_PIXELS) {
    throw new PluginRequestValidationFailedError(
      'worldSceneStream',
      `The first-frame image declares ${declared.width}x${declared.height} ` +
        `(${declared.width * declared.height} pixels), over the ` +
        `${MAX_SCENE_IMAGE_PIXELS}-pixel ceiling. It is cover-scaled and cropped to ` +
        'width x height anyway, so send one closer to the target resolution.'
    )
  }

  // A cancel that lands BEFORE `begin(...)` resolves is not merely early: the
  // registry consumes the marker and SKIPS admission entirely (see the
  // `preCancel` branch in request-registry.ts), so this context holds NO world
  // slot. Another request may own it and be mid-generation right now. Carrying
  // on would tear its session down under it, overwrite the `inFlight` guard
  // teardown waits on, and — via `discardStagedScene` in the `finally` below —
  // delete the staging file it is generating into, since that path is shared per
  // session. Refuse before touching any of it.
  if (ctx.signal.aborted) {
    throw new InferenceCancelledError(ctx.requestId)
  }

  // Replacing the world of a live session: the native session pins the scene it
  // was activated with, and `load()` is a no-op once loaded, so a rewritten pack
  // underneath it would be ignored and the walk would silently continue in the
  // old world. Dropping the session first also frees its ~16 GB before the
  // encoders (~6.9 GB) load, which a 24 GB card needs.
  await session.deactivate()

  // `deactivate()` awaits the session lock and any in-flight native job, so a
  // cancel can land across it. Re-check: the same slot-less race applies to
  // everything below, and unlike `worldStep` there is no abort hook to fall back
  // on — `createScene` takes no abort predicate, so once dispatched it runs to
  // completion whatever the caller does.
  if (ctx.signal.aborted) {
    throw new InferenceCancelledError(ctx.requestId)
  }

  // Generated into a staging file and promoted only on success: a failed
  // generation must leave the caller with the world they already had, not with
  // a model that has none.
  //
  // Every exit that is not a completed promotion drops the staged file, which
  // takes three shapes and needs all three covered. A `catch` alone misses the
  // consumer abandoning the generator — that unwinds as a return completion, so
  // `finally` runs and `catch` does not. A `finally` alone cannot tell success
  // from failure. Hence the flag. The native side can leave a partial file
  // behind on a dispatch rejection too, so the dispatch sits inside the guard
  // rather than in front of it.
  let promoted = false
  let response: SceneResponseWithStats & { iterate(): AsyncIterable<unknown> }
  let scene: Buffer | undefined

  try {
    response = (await session.run(() =>
      session.createScene({
        prompt: request.prompt,
        image,
        t5,
        vae,
        output: session.stagingScenePath,
        ...(request.width !== undefined && { width: request.width }),
        ...(request.height !== undefined && { height: request.height })
      })
    )) as unknown as SceneResponseWithStats & { iterate(): AsyncIterable<unknown> }

    try {
      // The completion payload carries the pack's absolute path on this machine
      // and a timing already reported by stats.sceneCreateMs, so nothing from
      // the stream is forwarded — the caller may be a remote peer and has no
      // business knowing our filesystem layout.
      for await (const chunk of response.iterate()) {
        void chunk
      }
    } finally {
      // Scene creation takes no abort predicate, so cancelling or disconnecting
      // stops delivery but not the encode. This runs even when the consumer
      // abandons the generator, and it sits inside the `await using ctx` scope —
      // so the model's concurrency slot is held until the native job is really
      // done. Releasing it earlier would admit the next request into a session
      // that is still busy.
      await session.settle()
    }

    if (ctx.signal.aborted) {
      throw new InferenceCancelledError(ctx.requestId)
    }

    scene = await session.promoteStagedScene(request.returnPack === true)
    promoted = true

    // Promotion is not instantaneous: it awaits the session lock, a stat, a
    // rename and optionally a whole readFile. A cancel accepted across any of
    // those would otherwise fall through to the terminal `done` payload below
    // and report success for a request the caller already withdrew.
    //
    // Checked AFTER `promoted = true` on purpose. The rename has happened, so
    // the world is real and the caller's previous one is already gone —
    // discarding now would destroy a valid world to honour a cancel. The
    // soft-cancel contract is that delivery stops, not that the encode is
    // undone; this suppresses the payload and leaves the world in place for the
    // next step to activate.
    if (ctx.signal.aborted) {
      throw new InferenceCancelledError(ctx.requestId)
    }
  } finally {
    if (!promoted) await session.discardStagedScene()
  }

  requestLogger.info(
    `World scene pack created for ${request.modelId}` +
      (scene ? ` (${scene.length} bytes returned)` : ' (pack retained server-side)')
  )

  const { stats } = response as SceneResponseWithStats
  yield {
    type: 'worldSceneStream',
    ...(scene && { data: Buffer.from(scene).toString('base64') }),
    done: true,
    ...(stats && { stats })
  }
}
