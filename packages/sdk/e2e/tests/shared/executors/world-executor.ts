import { cancel, worldCreateScene, worldStep } from '@qvac/sdk'
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
  type HandlerFn,
  type ExtractTest
} from '@tetherto/qvac-test-suite'
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

  private async createWorld(modelId: string, params: WorldParams, width = 448, height = 256) {
    const run = worldCreateScene({
      modelId,
      prompt: SCENE_PROMPT,
      image: await this.firstFrame(params),
      width,
      height
    })
    return run.scene
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
    const scene = await this.createWorld(
      modelId,
      params,
      params['width'] as number,
      params['height'] as number
    )
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
    // Idle: an empty key array must be accepted and still generate a block.
    const frames = await worldStep({ modelId, keys: params['keys'] as string[] }).frames
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
    const modelId = await this.resources.ensureLoaded(RESOURCE)
    try {
      // Rejected client-side by parseClientInput, before any RPC.
      worldStep({ modelId, keys: params['keys'] as string[] })
      return { passed: false, output: 'an unmapped walk key was accepted' }
    } catch (error) {
      return ValidationHelpers.validate(
        error instanceof Error ? error.message : String(error),
        expectation
      )
    }
  }

  async invalidDimensions(params: WorldParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded(RESOURCE)
    try {
      worldCreateScene({
        modelId,
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
    try {
      // One job per model: the second is refused rather than queued, so a live
      // key loop cannot build a backlog of stale presses.
      await worldStep({ modelId, keys: ['S'] }).frames
      return { passed: false, output: 'an overlapping step was admitted' }
    } catch (error) {
      return ValidationHelpers.validate(
        error instanceof Error ? error.message : String(error),
        expectation
      )
    } finally {
      await running.frames.catch(() => {})
    }
  }

  async cancelThenReload(params: WorldParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded(RESOURCE)
    await this.createWorld(modelId, params)

    const inFlight = worldStep({ modelId, keys: params['keys'] as string[] })
    setTimeout(() => {
      void cancel({ requestId: inFlight.requestId })
    }, 1500)

    // Either outcome is correct: the engine cannot abort mid-block, so a cancel
    // arriving after the block finished legitimately resolves. What must hold
    // is that the session recovers.
    await inFlight.frames.catch(() => undefined)

    await this.resources.evict(RESOURCE)
    const reloaded = await this.resources.ensureLoaded(RESOURCE)
    await this.createWorld(reloaded, params)
    const frames = await worldStep({ modelId: reloaded, keys: ['W'] }).frames
    return ValidationHelpers.validate(frames, expectation)
  }
}
