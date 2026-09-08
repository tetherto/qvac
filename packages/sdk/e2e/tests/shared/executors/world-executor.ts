import { cancel, worldCreateScene, worldStep } from '@qvac/sdk'
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
  type HandlerFn,
  type ExtractTest
} from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  worldTests,
  worldCancelThenReload,
  worldConcurrentStepRejected,
  worldCreateSceneReturnsPack,
  worldFirstBlockFrames,
  worldInvalidDimensionsRejected,
  worldInvalidKeyRejected,
  worldSecondBlockFrames,
  worldStepBeforeSceneFails
} from '../../world-tests.js'

export type WorldParams = Record<string, unknown> & {
  /** Filename under e2e/assets/images; a platform subclass resolves it to bytes. */
  image?: string | Uint8Array
}

const RESOURCE = 'world'
const SCENE_PROMPT = '| unknown | A realistic outdoor world scene with a navigable path.'

/**
 * Stand-in id for the tests that only exercise client-side validation. The
 * request never reaches the server, so the id is never resolved — using a real
 * one would mean loading 13.3 GB of weights to check a string.
 */
const UNLOADED_MODEL_ID = 'world-client-validation-only'

/**
 * Drives the ABot-World session ops. Every test that walks must create a world
 * first: the session defers activation until a scene pack exists, so a step on
 * a freshly loaded model is expected to fail until `worldCreateScene` has run.
 */
export class WorldExecutor extends AbstractModelExecutor<typeof worldTests> {
  pattern = /^world-/

  /**
   * Platform hook, mirroring DiffusionExecutor: params carry an image filename
   * and the platform subclass turns it into bytes, so this file stays free of
   * any filesystem API.
   */
  protected async resolveParams(p: WorldParams): Promise<WorldParams> {
    return p
  }

  private async firstFrame(params: WorldParams): Promise<Uint8Array> {
    const resolved = await this.resolveParams(params)
    if (!(resolved.image instanceof Uint8Array)) {
      throw new Error(
        'world executor: image param was not resolved to bytes by the platform subclass'
      )
    }
    return resolved.image
  }

  // The walk tests only need the world live on the session, so this deliberately
  // does NOT ask for the pack — it exercises the default and skips a ~14 MB
  // base64 round-trip per test. `stats` is the completion signal.
  private async createWorld(modelId: string, params: WorldParams, width = 448, height = 256) {
    const run = worldCreateScene({
      modelId,
      prompt: SCENE_PROMPT,
      image: await this.firstFrame(params),
      width,
      height
    })
    return run.stats
  }

  // Exhaustive testId → handler map; `Required<...>` turns a missing handler
  // into a compile error.
  protected handlers: Required<{
    [K in (typeof worldTests)[number]['testId']]: HandlerFn<ExtractTest<typeof worldTests, K>>
  }> = {
    [worldCreateSceneReturnsPack.testId]: this.createScene.bind(this),
    [worldFirstBlockFrames.testId]: this.firstBlock.bind(this),
    [worldSecondBlockFrames.testId]: this.secondBlock.bind(this),
    [worldStepBeforeSceneFails.testId]: this.stepBeforeScene.bind(this),
    [worldInvalidKeyRejected.testId]: this.invalidKey.bind(this),
    [worldInvalidDimensionsRejected.testId]: this.invalidDimensions.bind(this),
    [worldConcurrentStepRejected.testId]: this.concurrentStep.bind(this),
    [worldCancelThenReload.testId]: this.cancelThenReload.bind(this)
  }

  // ----- handlers -----

  async createScene(params: WorldParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded(RESOURCE)
    const width = params['width'] as number
    const height = params['height'] as number
    // This is the test that asserts the pack itself comes back, so it is the one
    // place that opts in.
    const run = worldCreateScene({
      modelId,
      prompt: SCENE_PROMPT,
      image: await this.firstFrame(params),
      width,
      height,
      returnPack: true
    })
    const scene = await run.scene
    const stats = await run.stats

    // The stats the profiler reports for this op, so a server that stopped
    // emitting them fails here rather than silently degrading telemetry.
    if (!stats?.sceneCreateMs || stats.sceneCreateMs <= 0) {
      return { passed: false, output: `sceneCreateMs was ${stats?.sceneCreateMs}` }
    }
    if (stats.width !== width || stats.height !== height) {
      return {
        passed: false,
        output: `scene reports ${stats.width}x${stats.height}, requested ${width}x${height}`
      }
    }
    return ValidationHelpers.validate(scene, expectation)
  }

  async firstBlock(params: WorldParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded(RESOURCE)
    await this.createWorld(modelId, params)

    const run = worldStep({ modelId, keys: params['keys'] as string[] })
    const frames = await run.frames
    const stats = await run.stats

    const expectedMask = params['expectedActionMask'] as number | undefined
    if (expectedMask !== undefined && stats?.actionMask !== expectedMask) {
      return {
        passed: false,
        output: `actionMask was ${stats?.actionMask}, expected ${expectedMask}`
      }
    }
    if (stats?.totalSteps !== 1) {
      return { passed: false, output: `totalSteps was ${stats?.totalSteps}, expected 1` }
    }
    return ValidationHelpers.validate(frames, expectation)
  }

  async secondBlock(params: WorldParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded(RESOURCE)
    await this.createWorld(modelId, params)

    await worldStep({ modelId, keys: ['W'] }).frames
    // Idle: an empty key array must be accepted AND reach the engine as mask 0.
    // Without the mask check a silent coercion to some default key set would
    // still produce 12 frames and pass.
    const run = worldStep({ modelId, keys: params['keys'] as string[] })
    const frames = await run.frames
    const stats = await run.stats
    const expectedMask = params['expectedActionMask'] as number | undefined
    if (expectedMask !== undefined && stats?.actionMask !== expectedMask) {
      return {
        passed: false,
        output: `actionMask was ${stats?.actionMask}, expected ${expectedMask}`
      }
    }
    return ValidationHelpers.validate(frames, expectation)
  }

  async stepBeforeScene(_params: WorldParams, expectation: Expectation): Promise<TestResult> {
    // Evict first: the resource is shared, so an earlier test in the batch may
    // already have built a world on this model, and stepping would then
    // legitimately succeed. Unloading deletes the managed pack, so the reload
    // below is a genuinely world-less session — which is the precondition this
    // test is actually about.
    await this.resources.evict(RESOURCE)
    const modelId = await this.resources.ensureLoaded(RESOURCE)
    try {
      await worldStep({ modelId, keys: ['W'] }).frames
      return { passed: false, output: 'stepping before a scene existed unexpectedly succeeded' }
    } catch (error) {
      return ValidationHelpers.validate(
        error instanceof Error ? error.message : String(error),
        expectation
      )
    }
  }

  async invalidKey(params: WorldParams, expectation: Expectation): Promise<TestResult> {
    try {
      // Rejected client-side by parseClientInput, before any RPC — so this test
      // must NOT load a model. It is declared `dependency: 'none'`, and calling
      // ensureLoaded here would pull the 13.3 GB ABot set to exercise a string
      // check that never leaves the process.
      worldStep({ modelId: UNLOADED_MODEL_ID, keys: params['keys'] as string[] })
      return { passed: false, output: 'an unmapped walk key was accepted' }
    } catch (error) {
      return ValidationHelpers.validate(
        error instanceof Error ? error.message : String(error),
        expectation
      )
    }
  }

  async invalidDimensions(params: WorldParams, expectation: Expectation): Promise<TestResult> {
    try {
      // Same as invalidKey: the multiple-of-32 refinement runs client-side.
      worldCreateScene({
        modelId: UNLOADED_MODEL_ID,
        prompt: SCENE_PROMPT,
        image: await this.firstFrame(params),
        width: params['width'] as number,
        height: params['height'] as number
      })
      return { passed: false, output: 'a non-multiple-of-32 dimension was accepted' }
    } catch (error) {
      return ValidationHelpers.validate(
        error instanceof Error ? error.message : String(error),
        expectation
      )
    }
  }

  async concurrentStep(params: WorldParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded(RESOURCE)
    await this.createWorld(modelId, params)

    const running = worldStep({ modelId, keys: params['keys'] as string[] })

    // Issue the overlap immediately. Waiting for a frame first would defeat the
    // test: world generates the whole block before emitting any frame, so by
    // the time one arrives the job is finishing and the slot is free — the
    // overlap would then be admitted legitimately.
    let overlap: TestResult
    try {
      // One job per model: the second is refused rather than queued, so a live
      // key loop cannot build a backlog of stale presses.
      await worldStep({ modelId, keys: ['S'] }).frames
      overlap = { passed: false, output: 'an overlapping step was admitted' }
    } catch (error) {
      overlap = ValidationHelpers.validate(
        error instanceof Error ? error.message : String(error),
        expectation
      )
    }

    // Admission is proven after the fact instead: the first step must have run
    // a full block. Without this the overlap could have been refused for an
    // unrelated reason (an absent world, say) and this would report
    // concurrency coverage it never exercised.
    const firstBlock = await running.frames.catch(() => [] as Uint8Array[])
    if (firstBlock.length === 0) {
      return {
        passed: false,
        output: 'the first step delivered no frames, so it never held the slot'
      }
    }
    return overlap
  }

  async cancelThenReload(params: WorldParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded(RESOURCE)
    await this.createWorld(modelId, params)

    // Warm the session with a COMPLETED step first. Without this the cancel
    // races `ensureActivated()` — the session defers activation to the first
    // step, so a cancel arriving during that load is refused before dispatch and
    // no block ever runs. That path is worth having, but it is not the one this
    // test is named for: cancelling a block that is genuinely in flight.
    const warmup = await worldStep({ modelId, keys: params['keys'] as string[] }).frames
    if (!Array.isArray(warmup) || warmup.length === 0) {
      return {
        passed: false,
        output: 'warm-up step delivered no frames, so nothing was in flight to cancel'
      }
    }

    const inFlight = worldStep({ modelId, keys: params['keys'] as string[] })

    // AWAIT the cancel so the assertion rests on one the server accepted — an
    // unsuccessful cancel throws CancelFailedError.
    //
    // The original version fired from a 1500 ms timer and accepted either
    // outcome, on the grounds that a cancel landing after the block finished
    // legitimately resolves. Sound, but it made the test unfalsifiable: with
    // cancellation removed entirely every run would take the "resolved" branch
    // and still pass. A cancel accepted against a live request must make the
    // step reject — the op raises InferenceCancelledError rather than yielding
    // `done`, precisely so a truncated block is never dressed up as success.
    await new Promise((resolve) => setTimeout(resolve, 300))
    await cancel({ requestId: inFlight.requestId })

    let cancelOutcome = 'resolved'
    await inFlight.frames.catch((error: unknown) => {
      cancelOutcome = error instanceof Error ? error.message : String(error)
    })
    if (cancelOutcome === 'resolved') {
      return {
        passed: false,
        output: 'the step completed normally after an accepted cancel — cancellation had no effect'
      }
    }
    if (!/cancel/i.test(cancelOutcome)) {
      return {
        passed: false,
        output: `in-flight step failed for a non-cancel reason: ${cancelOutcome}`
      }
    }

    // The documented recovery: SAME loaded model, no eviction and no second
    // worldCreateScene. The SDK drops the cancelled session itself, so this step
    // must transparently rebuild it from the pack already promoted above. The
    // previous version evicted and recreated the scene, which is exactly the
    // unloadModel/loadModel cycle the recovery exists to make unnecessary — so
    // it would have passed even with the rebuild removed.
    const frames = await worldStep({ modelId, keys: ['W'] }).frames
    const result = ValidationHelpers.validate(frames, expectation)
    return {
      ...result,
      output: `${result.output} [warm-up: ${warmup.length} frames; in-flight step: ${cancelOutcome}]`
    }
  }
}
