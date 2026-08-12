import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import WorldStableDiffusion from '@qvac/diffusion-cpp/world'
import type { WorldConfig } from '@qvac/diffusion-cpp/world'
import type QvacLogger from '@qvac/logging'
import { getServerLogger } from '@/logging'
import { getModel, getModelEntry } from '@/server/bare/registry/model-registry'
import { getRequestRegistry, withRequestContext } from '@/server/bare/runtime'
import { generateServerRequestId } from '@/server/bare/runtime/request-id'
import { getCacheDir, generateShortHash } from '@/server/utils'
import {
  InferenceCancelledError,
  ModelOperationNotSupportedError,
  PluginRequestValidationFailedError
} from '@/utils/errors-server'
import { ModelType } from '@/schemas'
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
  ensureActivated(): Promise<void>
  deactivate(): Promise<void>
  /** Promote a freshly generated pack; the previous world is replaced only here. */
  commitStagedScene(): Promise<void>
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
 * Server-side path for a model's scene pack. Derived from a hash of the
 * caller-supplied `modelId` rather than the id itself, so the id can never
 * steer the write, and kept stable so `createScene` writes exactly where the
 * native session was constructed to read (`files.scene` is fixed at
 * construction — pointing them at different paths silently walks the wrong
 * world).
 */
export function worldScenePath(modelId: string): string {
  return path.join(getCacheDir('world-scenes'), `${generateShortHash(modelId)}.safetensors`)
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
  const world: NativeWorldSession =
    args.world ?? new WorldStableDiffusion({ files, config, logger, opts: { stats: true } })
  const stagingScenePath = `${files.scene}.staging`

  let activated = false
  let inFlight: Promise<unknown> | null = null

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
    settle: settleInFlight,

    // Only here does a new world replace the old one. `rename` within the same
    // directory is atomic, so a reader never sees a half-written pack and a
    // crash mid-generation cannot leave the model pointing at one.
    async commitStagedScene() {
      await fsPromises.rename(stagingScenePath, files.scene)
    },

    // Generation failed: drop the staged file and leave the previous pack in
    // place, so the next step re-activates the world the caller already had
    // rather than finding the model worldless.
    async discardStagedScene() {
      await removeIfPresent(stagingScenePath)
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
        await fsPromises.copyFile(seedScenePath, files.scene)
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
      if (activated) return
      if (!hasScene()) {
        // A request-time precondition on a model that loaded fine, so this is a
        // bad request rather than a load failure.
        throw new PluginRequestValidationFailedError(
          'worldStepStream',
          `No world exists for model "${modelId}". Create one with worldCreateScene({ modelId, prompt, image }), ` +
            'or load the model with modelConfig.sceneSrc pointing at an existing scene pack.'
        )
      }
      await activate()
    },

    // The native session caches the scene it was activated with, and `load()`
    // is a no-op once loaded — so a rewritten pack would be ignored and the
    // walk would silently continue in the old world. Drop the session first.
    async deactivate() {
      if (!activated) return
      await settleInFlight()
      await world.unload()
      activated = false
    },

    // Tracks the job for `unload()` to wait on. It must follow the response to
    // its terminal state, not just the dispatch: `step()` and `createScene()`
    // resolve as soon as the native scheduler admits the job, while the block
    // or encode this guard exists for runs on well after that.
    async run(start) {
      const response = await start()
      // Swallowed because this handle only answers "has it finished?" — the
      // real failure still reaches the caller through `response.iterate()`.
      const settled = response.await().then(
        () => {},
        () => {}
      )
      inFlight = settled
      void settled.finally(() => {
        if (inFlight === settled) inFlight = null
      })
      return response
    },

    step: (keys) => world.step(keys),
    createScene: (params) => world.createScene(params),
    cancel: () => world.cancel(),

    async unload() {
      await settleInFlight()
      await world.unload()
      activated = false
      // The managed pack lives for exactly one loaded session. Callers who want
      // to revisit a world keep the bytes `worldCreateScene` returned and pass
      // them back as `modelConfig.sceneSrc`; without this every world would
      // leave ~10 MB behind under ~/.qvac/world-scenes for good.
      await removeIfPresent(files.scene)
      await removeIfPresent(stagingScenePath)
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
  const modelType = entry && !entry.isDelegated ? entry.local.modelType : ModelType.sdcppGeneration
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
    requestId: request.requestId ?? generateServerRequestId(),
    kind: 'world',
    modelId: request.modelId
  })
  const requestLogger = withRequestContext(getServerLogger(), ctx)
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

  const response = await session.run(() => session.step(request.keys ?? []))

  let frameIndex = 0

  try {
    for await (const chunk of response.iterate()) {
      if (ctx.signal.aborted) break
      if (chunk instanceof Uint8Array) {
        yield {
          type: 'worldStepStream',
          data: Buffer.from(chunk).toString('base64'),
          frameIndex: frameIndex++
        }
      }
      // The native progress tick carries step/frames/elapsed_ms, all of which
      // the terminal stats already report — so it is not forwarded.
    }
  } finally {
    // Cancel is block-granular, so the DiT keeps going after we stop reading.
    // Hold the model's slot until it stops, or the next step is admitted into a
    // session the addon will reject as busy. Runs on early consumer exit too.
    await session.settle()
  }

  // A cancelled block must not be reported as a finished one. The DiT already
  // committed it to the session history, so the frames we did not deliver are
  // gone for good and the walk resumes past them — yielding `done` here would
  // hand the caller a silent gap dressed up as success. The addon makes the
  // step itself reject for the same reason; this covers the race where we stop
  // iterating before that rejection lands.
  if (ctx.signal.aborted) {
    throw new InferenceCancelledError(ctx.requestId)
  }

  const { stats } = response as unknown as StepResponseWithStats
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
    requestId: request.requestId ?? generateServerRequestId(),
    kind: 'world',
    modelId: request.modelId
  })
  const requestLogger = withRequestContext(getServerLogger(), ctx)
  const session = asWorldSession(getModel(request.modelId), request.modelId, 'worldCreateScene')

  const { t5, vae } = session.encoders
  if (!t5 || !vae) {
    throw new PluginRequestValidationFailedError(
      'worldSceneStream',
      'Creating a world requires the prompt and image encoders. Load the model with ' +
        'modelConfig.t5XxlModelSrc (umT5-XXL) and modelConfig.vaeModelSrc (Wan2.2 VAE).'
    )
  }

  // Replacing the world of a live session: the native session pins the scene it
  // was activated with, and `load()` is a no-op once loaded, so a rewritten pack
  // underneath it would be ignored and the walk would silently continue in the
  // old world. Dropping the session first also frees its ~16 GB before the
  // encoders (~6.9 GB) load, which a 24 GB card needs.
  await session.deactivate()

  // Generated into a staging file and promoted only on success: a failed
  // generation must leave the caller with the world they already had, not with
  // a model that has none.
  const response = await session.run(() =>
    session.createScene({
      prompt: request.prompt,
      image: Buffer.from(request.image, 'base64'),
      t5,
      vae,
      output: session.stagingScenePath,
      ...(request.width !== undefined && { width: request.width }),
      ...(request.height !== undefined && { height: request.height })
    })
  )

  try {
    // The completion payload carries the pack's absolute path on this machine
    // and a timing already reported by stats.sceneCreateMs, so nothing from the
    // stream is forwarded — the caller may be a remote peer and has no business
    // knowing our filesystem layout.
    for await (const chunk of response.iterate()) {
      void chunk
    }
  } catch (error) {
    await session.discardStagedScene()
    throw error
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
    await session.discardStagedScene()
    throw new InferenceCancelledError(ctx.requestId)
  }

  await session.commitStagedScene()

  const scene = await fsPromises.readFile(session.scenePath)
  requestLogger.info(`World scene pack created for ${request.modelId} (${scene.length} bytes)`)

  const { stats } = response as unknown as SceneResponseWithStats
  yield {
    type: 'worldSceneStream',
    data: Buffer.from(scene).toString('base64'),
    done: true,
    ...(stats && { stats })
  }
}
