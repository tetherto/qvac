import test from 'brittle'
import fs from 'bare-fs'
import type { NativeWorldSession, WorldSession } from '@/plugins/builtin/sdcpp-generation/ops/world'

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}-${Date.now()}`
}

/**
 * A minimal but VALID PNG header declaring `width`x`height`.
 *
 * The scene op refuses a first frame whose dimensions it cannot read — a size
 * guard that failed open on an unreadable header would be skippable by sending
 * any other format — so tests have to hand it something real rather than a few
 * arbitrary bytes.
 */
function pngHeader(width = 448, height = 256): string {
  const buf = Buffer.alloc(24)
  buf[0] = 0x89
  buf[1] = 0x50
  buf[2] = 0x4e
  buf[3] = 0x47
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf.toString('base64')
}

/** A QvacResponse stand-in whose stream and settlement the test drives. */
function makeResponse(chunks: readonly unknown[]) {
  let releaseStream = () => {}
  let settleJob = () => {}
  const streamGate = new Promise<void>((resolve) => {
    releaseStream = resolve
  })
  const finished = new Promise<void>((resolve) => {
    settleJob = resolve
  })

  return {
    releaseStream,
    settleJob,
    finished,
    response: {
      async *iterate() {
        for (const chunk of chunks) yield chunk
        // Stays open until the test lets it close, so a cancel can land while
        // the block is still streaming.
        await streamGate
      },
      await: () => finished
    }
  }
}

/**
 * Builds the five methods `createWorldSession` calls. One cast, because the
 * driver's response deliberately implements only the two members the ops use
 * rather than all of QvacResponse.
 */
function fakeNativeSession(
  response: unknown,
  unload: () => Promise<void> = async () => {}
): NativeWorldSession {
  return {
    load: async () => {},
    unload,
    step: async () => response,
    createScene: async () => response,
    cancel: async () => {}
  } as unknown as NativeWorldSession
}

async function withWorldSession<T>(
  world: NativeWorldSession,
  body: (ctx: { modelId: string; session: WorldSession }) => Promise<T>,
  opts: { withScene?: boolean } = {}
): Promise<T> {
  const [{ registerModel, unregisterModel }, { ModelType }, worldOps, { getEngineLogger }] =
    await Promise.all([
      import('@/runtime/model-registry'),
      import('@/schemas/index'),
      import('@/plugins/builtin/sdcpp-generation/ops/world'),
      import('@/logging/index')
    ])

  const modelId = makeId('test-world')
  const session = worldOps.createWorldSession({
    modelId,
    files: {
      model: '/tmp/dit.gguf',
      taehv: '/tmp/taehv.gguf',
      scene: worldOps.worldScenePath(modelId)
    },
    config: {},
    encoders: { t5: '/tmp/t5.gguf', vae: '/tmp/vae.gguf' },
    logger: getEngineLogger(),
    world
  })

  // ensureActivated() refuses to activate without a pack on disk.
  if (opts.withScene !== false) {
    fs.writeFileSync(session.scenePath, 'scene')
  }

  try {
    registerModel(modelId, {
      model: session as never,
      path: '/tmp/dit.gguf',
      config: {},
      modelType: ModelType.sdcppGeneration
    } as never)
    return await body({ modelId, session })
  } finally {
    unregisterModel(modelId)
    try {
      fs.unlinkSync(session.scenePath)
    } catch {}
  }
}

test('world session: teardown waits for the whole job, not just its dispatch', async function (t) {
  const driver = makeResponse([new Uint8Array([1])])
  let nativeUnloaded = false

  await withWorldSession(
    fakeNativeSession(driver.response, async () => {
      nativeUnloaded = true
    }),
    async ({ session }) => {
      // step() resolves as soon as the native scheduler admits the job — the
      // block itself runs on well past that. Teardown must track the latter.
      await session.run(async () => driver.response)

      let unloadDone = false
      const unloading = session.unload().then(() => {
        unloadDone = true
      })

      await new Promise<void>((resolve) => setTimeout(() => resolve(), 50))
      t.absent(unloadDone, 'unload does not return while the native job is in flight')
      t.absent(
        nativeUnloaded,
        'native teardown is not entered mid-job — that is what freezes the loop'
      )

      driver.settleJob()
      await unloading
      t.ok(nativeUnloaded, 'native teardown runs once the job has settled')
    }
  )
})

test('world step op: a cancelled block rejects instead of reporting done', async function (t) {
  const [{ worldStep }, { getRequestRegistry }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/ops/world'),
    import('@/runtime/index')
  ])
  const driver = makeResponse([new Uint8Array([1, 2, 3])])

  await withWorldSession(fakeNativeSession(driver.response), async ({ modelId }) => {
    const requestId = makeId('req')
    const stream = worldStep({ modelId, requestId, keys: ['W'] })

    const first = await stream.next()
    t.ok(
      (first.value as { data?: string } | undefined)?.data,
      'frames are delivered as the block streams'
    )

    getRequestRegistry().cancel({ requestId })
    driver.releaseStream()
    driver.settleJob()

    // The undelivered frames are gone: the session that advanced past them is
    // torn down, and the next step restarts from the promoted pack. Reporting
    // `done` here would hand the caller a silent gap dressed as success.
    let terminal: IteratorResult<unknown> | undefined
    let threw: Error | undefined
    try {
      terminal = await stream.next()
    } catch (error) {
      threw = error as Error
    }

    t.ok(threw, 'the cancelled step rejects')
    t.absent(
      (terminal?.value as { done?: boolean } | undefined)?.done,
      'no success terminal is emitted for a cancelled block'
    )
  })
})

// A block delivers every frame at its end, so the addon's mid-block tick is the
// only liveness a caller gets across 1.8-7.5s. ops/video.ts:213 and
// ops/diffusion.ts forward theirs the same way.
test('world step op: the end-of-block progress tick is forwarded', async function (t) {
  const { worldStep } = await import('@/plugins/builtin/sdcpp-generation/ops/world')

  // Ordered exactly as WorldSessionModel.cpp emits: every frame first, then ONE
  // progress tick carrying the block's final delivered count. Also includes a
  // non-JSON string and a JSON object with no `step`, both of which must be
  // dropped rather than yielded or thrown on.
  const driver = makeResponse([
    new Uint8Array([1]),
    new Uint8Array([2]),
    'not json at all',
    '{"unrelated":true}',
    '{"step":1,"frames":2,"elapsed_ms":1800}'
  ])

  await withWorldSession(fakeNativeSession(driver.response), async ({ modelId }) => {
    const stream = worldStep({ modelId, requestId: makeId('req'), keys: ['W'] })

    const ticks: Array<Record<string, unknown>> = []
    const frames: Array<Record<string, unknown>> = []
    const collect = (async () => {
      for await (const chunk of stream) {
        const c = chunk as unknown as Record<string, unknown>
        if (c['data'] !== undefined) frames.push(c)
        else if (c['step'] !== undefined) ticks.push(c)
      }
    })()

    await new Promise<void>((resolve) => setTimeout(() => resolve(), 20))
    driver.releaseStream()
    driver.settleJob()
    await collect.catch(() => {})

    t.is(ticks.length, 1, 'exactly one tick per block, as the engine emits')
    t.alike(
      ticks[0],
      { type: 'worldStepStream', step: 1, totalSteps: 2, elapsedMs: 1800 },
      "it carries the block's final delivered count, under the sibling field names"
    )
    t.is(frames.length, 2, 'and every frame is still delivered')
    t.absent(
      ticks.some((tick) => tick['data'] !== undefined),
      'a tick is never confused for a frame'
    )
  })
})

test('world scene op: the model slot is held until uninterruptible work settles', async function (t) {
  const [{ worldCreateScene }, { getRequestRegistry }, { RequestRejectedByPolicyError }] =
    await Promise.all([
      import('@/plugins/builtin/sdcpp-generation/ops/world'),
      import('@/runtime/index'),
      import('@/errors/index')
    ])
  const driver = makeResponse(['{"scene":"/server/path.safetensors","elapsed_ms":10}'])

  await withWorldSession(fakeNativeSession(driver.response), async ({ modelId }) => {
    const stream = worldCreateScene({
      modelId,
      requestId: makeId('scene'),
      prompt: 'a forest path',
      image: pngHeader()
    })

    // Start the op, then abandon the consumer mid-encode. The native encode
    // takes no abort predicate, so it runs on regardless — which is exactly
    // the case the slot must survive.
    const pending = stream.next()
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 20))
    const returning = stream.return(undefined)
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 20))

    let rejected = false
    try {
      const ctx = await getRequestRegistry().begin({
        requestId: makeId('req'),
        kind: 'world',
        modelId
      })
      await ctx[Symbol.asyncDispose]()
    } catch (error) {
      rejected = error instanceof RequestRejectedByPolicyError
    }
    t.ok(rejected, 'the slot is still held while the native encode runs')

    driver.releaseStream()
    driver.settleJob()
    await returning.catch(() => {})
    await pending.catch(() => {})
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 50))

    await using freed = await getRequestRegistry().begin({
      requestId: makeId('req'),
      kind: 'world',
      modelId
    })
    t.ok(freed.requestId, 'the slot is released once the native encode settles')
  })
})

// The addon contract puts cancellation in the same bucket as a failed step —
// "Treat it like any failed step: reload the session" — because the engine's
// RNG/history cannot be resumed either way. So a cancelled step must also drop
// the session, and the NEXT step must rebuild it with no explicit reload from
// the caller.
// Maxim's finding: an abort can land while `ensureActivated()` is still running.
// `onAbort` fires, but the native cancel flag it sets is cleared when the next
// block begins — so dispatching anyway would run a whole block, advance the
// session history, and deliver none of it. The caller sees a rejection while the
// world has silently moved on.
test('world step op: a request aborted before dispatch never starts a native block', async function (t) {
  const [{ worldStep }, { getRequestRegistry }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/ops/world'),
    import('@/runtime/index')
  ])
  const driver = makeResponse([new Uint8Array([1])])

  let steps = 0
  const counting = {
    load: async () => {},
    unload: async () => {},
    step: async () => {
      steps++
      return driver.response
    },
    createScene: async () => driver.response,
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(counting, async ({ modelId }) => {
    const requestId = makeId('req')
    const stream = worldStep({ modelId, requestId, keys: ['W'] })

    // Cancel before the generator body has run at all, so the abort is already
    // set by the time activation completes.
    getRequestRegistry().cancel({ requestId })

    await t.exception(stream.next(), /cancelled/i, 'the step rejects as a cancellation')
    t.is(steps, 0, 'no native block was dispatched, so the world did not move')
  })
})

// Maxim's second finding: the addon raises its own `Diffusion/Cancelled` out of
// iterate(), which left through the catch and never reached the typed
// conversion — so the client saw a generic RPC error for what this API promises
// as a typed cancellation.
test('world step op: a native cancellation surfaces as InferenceCancelledError', async function (t) {
  const [{ worldStep }, { getRequestRegistry }, { InferenceCancelledError }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/ops/world'),
    import('@/runtime/index'),
    import('@/errors/index')
  ])

  let settle = () => {}
  const finished = new Promise<void>((resolve) => {
    settle = resolve
  })
  let raise = () => {}
  const gate = new Promise<void>((resolve) => {
    raise = resolve
  })
  const nativeCancelling = {
    load: async () => {},
    unload: async () => {},
    step: async () => ({
      async *iterate() {
        yield new Uint8Array([1])
        await gate
        // What the addon actually throws once its cancel lands.
        throw new Error('Diffusion/Cancelled')
      },
      await: () => finished
    }),
    createScene: async () => ({
      async *iterate() {},
      await: () => finished
    }),
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(nativeCancelling, async ({ modelId }) => {
    const requestId = makeId('req')
    const stream = worldStep({ modelId, requestId, keys: ['W'] })
    await stream.next()

    getRequestRegistry().cancel({ requestId })
    raise()
    settle()

    let thrown: unknown
    try {
      await stream.next()
    } catch (error) {
      thrown = error
    }
    t.ok(
      thrown instanceof InferenceCancelledError,
      'the native cancellation is relabelled as the typed error the API promises'
    )
    t.is(
      (thrown as InstanceType<typeof InferenceCancelledError>).requestId,
      requestId,
      'and carries the requestId the caller cancelled with'
    )
  })
})

test('world step op: a cancelled step rebuilds the session without an explicit reload', async function (t) {
  const [{ worldStep }, { getRequestRegistry }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/ops/world'),
    import('@/runtime/index')
  ])
  // One response per step, handed out in order. Returning a single shared fake
  // would let the second step re-iterate the first one's chunks and pass without
  // the session ever having been rebuilt.
  const cancelled = makeResponse([new Uint8Array([1, 2, 3])])
  const resumedResponse = makeResponse([new Uint8Array([4])])
  const responses = [cancelled, resumedResponse]
  let stepCount = 0

  let loads = 0
  let unloads = 0
  const counting = {
    load: async () => {
      loads++
    },
    unload: async () => {
      unloads++
    },
    step: async () => responses[stepCount++]?.response,
    createScene: async () => cancelled.response,
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(counting, async ({ modelId }) => {
    const requestId = makeId('req')
    const stream = worldStep({ modelId, requestId, keys: ['W'] })
    await stream.next()

    getRequestRegistry().cancel({ requestId })
    cancelled.releaseStream()
    cancelled.settleJob()
    await stream.next().catch(() => {})

    t.is(loads, 1, 'the cancelled walk activated once')
    t.is(unloads, 1, 'a cancelled session is dropped, not kept for the next step')

    const resumed = worldStep({ modelId, requestId: makeId('req'), keys: ['W'] })
    const frame = await resumed.next()
    t.is(
      (frame.value as { data?: string } | undefined)?.data,
      Buffer.from([4]).toString('base64'),
      'the next step walks again — and on a FRESH native response, not the cancelled one'
    )
    t.is(loads, 2, 'and it rebuilt the native session from the same promoted pack')
    t.is(stepCount, 2, 'each step drove its own native job')

    resumedResponse.releaseStream()
    resumedResponse.settleJob()
    await resumed.return(undefined).catch(() => {})
  })
})

test('world step op: a terminal step failure drops the session so the next step rebuilds', async function (t) {
  const { worldStep } = await import('@/plugins/builtin/sdcpp-generation/ops/world')

  let loads = 0
  let unloads = 0
  const failing = {
    load: async () => {
      loads++
    },
    unload: async () => {
      unloads++
    },
    step: async () => ({
      // eslint-disable-next-line require-yield
      async *iterate() {
        throw new Error('native step failed')
      },
      await: async () => {}
    }),
    createScene: async () => ({
      async *iterate() {},
      await: async () => {}
    }),
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(failing, async ({ modelId }) => {
    const stream = worldStep({ modelId, requestId: makeId('req'), keys: ['W'] })
    await t.exception(stream.next(), /native step failed/, 'the failure reaches the caller')

    // Per the addon contract the native session is unusable after a failed step.
    // Without dropping it, every later step dispatches into dead state and the
    // only recovery is unloadModel + loadModel.
    t.is(unloads, 1, 'the dead session is torn down rather than left activated')

    const second = worldStep({ modelId, requestId: makeId('req'), keys: ['W'] })
    await t.exception(second.next(), /native step failed/, 'the next step still surfaces failures')
    t.is(loads, 2, 'the next step rebuilt the session from the promoted pack')
  })
})

// The dispatch rejects before any frame streams — `runStep` throwing on VRAM
// exhaustion is the documented shape. The addon fails the native job on its way
// out, so this is just as terminal as a mid-block failure and must reach the
// same teardown.
test('world step op: a dispatch-time step failure drops the session too', async function (t) {
  const { worldStep } = await import('@/plugins/builtin/sdcpp-generation/ops/world')

  let loads = 0
  let unloads = 0
  const failing = {
    load: async () => {
      loads++
    },
    unload: async () => {
      unloads++
    },
    step: async () => {
      throw new Error('native dispatch failed')
    },
    createScene: async () => ({
      async *iterate() {},
      await: async () => {}
    }),
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(failing, async ({ modelId }) => {
    const stream = worldStep({ modelId, requestId: makeId('req'), keys: ['W'] })
    await t.exception(stream.next(), /native dispatch failed/, 'the failure reaches the caller')
    t.is(unloads, 1, 'a dispatch rejection tears the session down, not just an iteration failure')

    const second = worldStep({ modelId, requestId: makeId('req'), keys: ['W'] })
    await t.exception(
      second.next(),
      /native dispatch failed/,
      'the next step still surfaces failures'
    )
    t.is(loads, 2, 'the next step rebuilt the session rather than reusing the dead one')
  })
})

// An early consumer exit unwinds the generator as a RETURN completion: the
// `catch` never runs and the signal is not aborted, so neither of the two flags
// the teardown used to test can see it. The native session is left advanced past
// frames the caller never received, which is the same hazard as a cancel.
test('world step op: abandoning the frame stream drops the advanced session', async function (t) {
  const { worldStep } = await import('@/plugins/builtin/sdcpp-generation/ops/world')

  let loads = 0
  let unloads = 0
  const driver = makeResponse([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])])
  const counting = {
    load: async () => {
      loads++
    },
    unload: async () => {
      unloads++
    },
    step: async () => driver.response,
    createScene: async () => driver.response,
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(counting, async ({ modelId }) => {
    const stream = worldStep({ modelId, requestId: makeId('req'), keys: ['W'] })

    const first = await stream.next()
    t.ok((first.value as { data?: string } | undefined)?.data, 'the first frame was delivered')

    // Walk away mid-block. The native job still has to finish, so release it and
    // let the settle the teardown waits on complete.
    driver.releaseStream()
    driver.settleJob()
    await stream.return(undefined)

    t.is(unloads, 1, 'the session advanced past undelivered frames is torn down')

    driver.releaseStream()
    driver.settleJob()
    const next = worldStep({ modelId, requestId: makeId('req'), keys: ['W'] })
    await next.next()
    await next.return(undefined)
    t.is(loads, 2, 'the next step rebuilt the session from the promoted pack')
  })
})

// `ops/diffusion.ts` has no model-type guard (unlike its `asVideoModel` /
// `asUpscalerModel` siblings), so a diffusion request aimed at a world model
// reaches WorldSession.run with an options object rather than a thunk. Assigning
// the in-flight guard before noticing would leave an already-settled promise in
// it, making settle() a no-op while a native block is still running — and
// teardown would then enter the addon's synchronous unload mid-job.
test('world session: a non-thunk run() is refused without clearing the guard', async function (t) {
  const { ModelOperationNotSupportedError } = await import('@/errors/index')
  const driver = makeResponse([new Uint8Array([1])])

  await withWorldSession(fakeNativeSession(driver.response), async ({ session }) => {
    await session.run(async () => driver.response)

    // What ops/diffusion.ts would hand us: a request object, not a function.
    // brittle's exception matcher takes a RegExp or a zero-arg Error class, and
    // this one needs five constructor args, so the class check is done by hand.
    let refused: unknown
    try {
      await session.run({ prompt: 'not a thunk' } as never)
    } catch (error) {
      refused = error
    }
    t.ok(
      refused instanceof ModelOperationNotSupportedError,
      'the mistyped call is refused with a structured error'
    )

    // The guard must still be armed: settle() has to keep waiting for the real
    // job, not return immediately.
    let settled = false
    const settling = session.settle().then(() => {
      settled = true
    })
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 50))
    t.absent(settled, 'the in-flight guard survived the mistyped call')

    driver.settleJob()
    await settling
    t.ok(settled, 'and still resolves once the real job finishes')
  })
})

// The addon wrapper clears `addon`/`configLoaded` only AFTER its own
// `addon.unload()` resolves, so a rejecting native unload leaves it still
// believing it is loaded. Clearing OUR `activated` there would make the next
// `load()` hit the wrapper's `if (configLoaded) return` no-op and report a live
// session over native state we already tried to destroy.
test('world session: a failed deactivate makes the session unusable, not silently stale', async function (t) {
  const { ModelNotLoadedError } = await import('@/errors/index')
  const { worldStep } = await import('@/plugins/builtin/sdcpp-generation/ops/world')
  const driver = makeResponse([new Uint8Array([1])])

  let loads = 0
  const failing = {
    load: async () => {
      loads++
    },
    unload: async () => {
      throw new Error('native teardown failed')
    },
    step: async () => driver.response,
    createScene: async () => driver.response,
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(failing, async ({ modelId, session }) => {
    await session.ensureActivated()
    t.is(loads, 1, 'the session activated')

    await t.exception(
      session.deactivate(),
      /native teardown failed/,
      'the failure reaches the caller'
    )

    // The important half: the next step must fail loudly rather than re-activate
    // into a wrapper that never actually tore down.
    let refused: unknown
    try {
      await worldStep({ modelId, requestId: makeId('req'), keys: ['W'] }).next()
    } catch (error) {
      refused = error
    }
    t.ok(refused instanceof ModelNotLoadedError, 'later steps refuse with ModelNotLoadedError')
    t.is(loads, 1, 'and no second load() was attempted against the stale wrapper')
  })
})

// The generated-pack ceiling is worthless if an oversized pack can simply arrive
// through sceneSrc instead — both land at files.scene and are loaded by the same
// native session.
// The per-axis and total-pixel ceilings bound ONE frame; numFramePerBlock bounds
// how many. Neither bounds the product, and the product is what is allocated: at
// the 1920x1088 ceiling with the 64-frame maximum that is ~1.49 GiB per block.
test('world scene op: count x resolution is bounded, not just each on its own', async function (t) {
  const worldOps = await import('@/plugins/builtin/sdcpp-generation/ops/world')
  const { getEngineLogger } = await import('@/logging/index')
  const { registerModel, unregisterModel } = await import('@/runtime/model-registry')
  const { ModelType } = await import('@/schemas/index')
  const fs = await import('bare-fs')
  const driver = makeResponse([])

  let scenes = 0
  const counting = {
    load: async () => {},
    unload: async () => {},
    step: async () => driver.response,
    createScene: async () => {
      scenes++
      return driver.response
    },
    cancel: async () => {}
  } as unknown as NativeWorldSession

  const modelId = makeId('test-world-block')
  const session = worldOps.createWorldSession({
    modelId,
    files: {
      model: '/tmp/dit.gguf',
      taehv: '/tmp/taehv.gguf',
      scene: worldOps.worldScenePath(modelId)
    },
    // Both individually legal: 64 is the numFramePerBlock maximum.
    config: { numFramePerBlock: 64 },
    encoders: { t5: '/tmp/t5.gguf', vae: '/tmp/vae.gguf' },
    logger: getEngineLogger(),
    world: counting
  })
  fs.writeFileSync(session.scenePath, 'scene')
  registerModel(modelId, {
    model: session as never,
    path: '/tmp/dit.gguf',
    config: {},
    modelType: ModelType.sdcppGeneration
  } as never)

  try {
    const stream = worldOps.worldCreateScene({
      modelId,
      requestId: makeId('scene'),
      prompt: 'a forest path',
      // Also individually legal: exactly the total-pixel ceiling.
      width: 1920,
      height: 1088,
      image: pngHeader()
    })
    await t.exception(stream.next(), /over the .*-byte ceiling/, 'the product is refused')
    t.is(scenes, 0, 'nothing reached the native encoder')

    // And the default shape at the same resolution still passes.
    const ok = worldOps.worldCreateScene({
      modelId,
      requestId: makeId('scene'),
      prompt: 'a forest path',
      width: 832,
      height: 480,
      image: pngHeader()
    })
    const pending = ok.next()
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 20))
    driver.releaseStream()
    driver.settleJob()
    await pending.catch(() => {})
    await ok.return(undefined).catch(() => {})
    t.is(scenes, 1, 'a sane block shape is unaffected')
  } finally {
    unregisterModel(modelId)
    try {
      fs.unlinkSync(session.scenePath)
    } catch {}
    await session.discardStagedScene().catch(() => {})
  }
})

// The rename is what replaces the caller's world, so it must be the LAST thing
// that can fail. Reading after it meant a failed read handed back an error
// against a world that had already been replaced, with no way back.
test('world session: a failed pack read leaves the previous world in place', async function (t) {
  const fs = await import('bare-fs')
  const driver = makeResponse([])

  await withWorldSession(fakeNativeSession(driver.response), async ({ session }) => {
    fs.writeFileSync(session.scenePath, 'the world the caller already had')
    // No staging file at all, so the read inside promotion fails.
    let failed: unknown
    try {
      await session.promoteStagedScene(true)
    } catch (error) {
      failed = error
    }

    t.ok(failed, 'promotion reports the failure')
    t.is(
      fs.readFileSync(session.scenePath, 'utf8'),
      'the world the caller already had',
      'and the previous world is untouched — nothing was committed'
    )
  })
})

test('world session: an oversized sceneSrc is refused like an oversized generated pack', async function (t) {
  const fs = await import('bare-fs')
  const bareOs = await import('bare-os')
  const barePath = await import('bare-path')
  const [worldOps, { getEngineLogger }, { ModelLoadFailedError }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/ops/world'),
    import('@/logging/index'),
    import('@/errors/index')
  ])

  const dir = barePath.join(bareOs.cwd(), 'test', 'tmp-world-seed')
  fs.mkdirSync(dir, { recursive: true })
  const seed = barePath.join(dir, 'oversized.safetensors')
  fs.writeFileSync(seed, Buffer.alloc(64))

  const modelId = makeId('test-world-seed')
  const session = worldOps.createWorldSession({
    modelId,
    files: {
      model: '/tmp/dit.gguf',
      taehv: '/tmp/taehv.gguf',
      scene: worldOps.worldScenePath(modelId)
    },
    config: {},
    encoders: { t5: '/tmp/t5.gguf', vae: '/tmp/vae.gguf' },
    seedScenePath: seed,
    logger: getEngineLogger(),
    world: fakeNativeSession(makeResponse([]).response),
    // Same injected-ceiling seam the generated-pack test uses: the real limit is
    // far larger than anything a test should write to disk.
    maxScenePackBytes: 16
  })

  try {
    let refused: unknown
    try {
      await session.load()
    } catch (error) {
      refused = error
    }
    t.ok(refused instanceof ModelLoadFailedError, 'the oversized seed is refused at load')
    t.absent(fs.existsSync(session.scenePath), 'and it was never copied into the managed slot')
  } finally {
    fs.rmSync(dir, { recursive: true })
  }
})

// A torn session refuses work by design, so the question is whether the ORDINARY
// recovery still works: unloadModel then loadModel. unloadModel unregisters the
// entry before teardown, so a native unload that throws again cannot strand it.
test('world session: a torn session is still recoverable by unload + load', async function (t) {
  const fs = await import('bare-fs')
  const [{ unloadModel }, { isModelLoaded, registerModel, unregisterModel }] = await Promise.all([
    import('@/plugins/ops/unload-model'),
    import('@/runtime/model-registry')
  ])
  const { ModelType } = await import('@/schemas/index')
  const { getEngineLogger } = await import('@/logging/index')
  const worldOps = await import('@/plugins/builtin/sdcpp-generation/ops/world')
  const driver = makeResponse([])

  const failing = {
    load: async () => {},
    unload: async () => {
      throw new Error('native teardown failed')
    },
    step: async () => driver.response,
    createScene: async () => driver.response,
    cancel: async () => {}
  } as unknown as NativeWorldSession

  const modelId = makeId('test-world-torn')
  const session = worldOps.createWorldSession({
    modelId,
    files: {
      model: '/tmp/dit.gguf',
      taehv: '/tmp/taehv.gguf',
      scene: worldOps.worldScenePath(modelId)
    },
    config: {},
    encoders: { t5: '/tmp/t5.gguf', vae: '/tmp/vae.gguf' },
    logger: getEngineLogger(),
    world: failing
  })
  fs.writeFileSync(session.scenePath, 'scene')
  registerModel(modelId, {
    model: session as never,
    path: '/tmp/dit.gguf',
    config: {},
    modelType: ModelType.sdcppGeneration
  } as never)

  try {
    await session.ensureActivated()
    await t.exception(session.deactivate(), /native teardown failed/, 'deactivate fails')
    t.ok(isModelLoaded(modelId), 'the model is still registered while torn')

    // The obvious recovery does NOT work: plugins/ops/load-model.ts returns
    // `{}` without doing anything while the id is registered, so a direct
    // reload silently hands back this same torn session.
    const { loadModel } = await import('@/plugins/ops/load-model')
    await loadModel({
      modelId,
      modelPath: '/tmp/dit.gguf',
      options: {
        type: 'loadModel',
        modelSrc: '/tmp/dit.gguf',
        modelType: ModelType.sdcppGeneration,
        modelConfig: { mode: 'world' }
      }
    } as never)
    t.ok(isModelLoaded(modelId), 'a direct reload is a no-op — the id is still registered')
    await t.exception(
      session.ensureActivated(),
      /not loaded/i,
      'and the session it hands back is still torn'
    )

    // The recovery that does work. The native unload throws again, so
    // unloadModel surfaces that — but it unregisters BEFORE teardown, so the
    // id is cleared regardless.
    await t.exception(unloadModel({ modelId }), /native teardown failed/, 'unload surfaces it')
    t.absent(isModelLoaded(modelId), 'the entry is unregistered despite the throw')
    t.absent(fs.existsSync(session.scenePath), 'and the managed pack is gone')
    // Only now can a load actually build a new session.
    t.absent(isModelLoaded(modelId), 'so loadModel would build a fresh session')
  } finally {
    unregisterModel(modelId)
    try {
      fs.unlinkSync(session.scenePath)
    } catch {}
  }
})

test('world session: unload removes the pack even when native teardown fails', async function (t) {
  const fs = await import('bare-fs')
  const driver = makeResponse([])

  const failing = {
    load: async () => {},
    unload: async () => {
      throw new Error('native teardown failed')
    },
    step: async () => driver.response,
    createScene: async () => driver.response,
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(failing, async ({ session }) => {
    fs.writeFileSync(session.stagingScenePath, 'staged')
    t.ok(fs.existsSync(session.scenePath), 'the pack exists before teardown')

    await t.exception(
      session.unload(),
      /native teardown failed/,
      'the failure still reaches the caller'
    )

    // Nothing ever comes back for this session: unload-model.ts unregisters the
    // entry before teardown, so a skipped removal leaks ~10 MB for good.
    t.absent(fs.existsSync(session.scenePath), 'the pack is removed anyway')
    t.absent(fs.existsSync(session.stagingScenePath), 'and so is the staging file')
  })
})

// The same slotless race as the scene op, but worse: `onAbort` fires
// `session.cancel()`, which is a MODEL-WIDE native cancel. A pre-cancelled step
// holding no slot would reach across and kill the block belonging to whichever
// request legitimately owns the lane.
test('world step op: a pre-cancelled step leaves the lane owner alone', async function (t) {
  const [{ worldStep }, { getRequestRegistry }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/ops/world'),
    import('@/runtime/index')
  ])
  const driver = makeResponse([new Uint8Array([1]), new Uint8Array([2])])

  let steps = 0
  let nativeCancels = 0
  const counting = {
    load: async () => {},
    unload: async () => {},
    step: async () => {
      steps++
      return driver.response
    },
    createScene: async () => driver.response,
    cancel: async () => {
      nativeCancels++
    }
  } as unknown as NativeWorldSession

  await withWorldSession(counting, async ({ modelId }) => {
    // The owner: admitted, holding the single world slot, block in flight.
    const owner = worldStep({ modelId, requestId: makeId('owner'), keys: ['W'] })
    const firstFrame = await owner.next()
    t.ok((firstFrame.value as { data?: string } | undefined)?.data, 'the owner is mid-block')
    t.is(steps, 1, 'exactly one native block is running')

    // The intruder: cancelled before its `begin(...)` resolves, so the registry
    // skips admission and it never holds the slot the owner has.
    const intruderId = makeId('intruder')
    const intruder = worldStep({ modelId, requestId: intruderId, keys: ['W'] })
    getRequestRegistry().cancel({ requestId: intruderId })

    await t.exception(intruder.next(), /cancelled/i, 'the intruder rejects as a cancellation')
    t.is(nativeCancels, 0, "the owner's in-flight block was not cancelled out from under it")
    t.is(steps, 1, 'and no second native block was dispatched')

    // The owner is still healthy and still delivering.
    const second = await owner.next()
    t.ok((second.value as { data?: string } | undefined)?.data, 'the owner keeps streaming')

    driver.releaseStream()
    driver.settleJob()
    await owner.return(undefined).catch(() => {})
  })
})

// A cancel landing BEFORE begin() resolves makes the registry skip admission
// entirely, so the context holds no world slot. Carrying on would tear down and
// overwrite a session another request legitimately owns.
test('world scene op: an already-cancelled request touches nothing', async function (t) {
  const fs = await import('bare-fs')
  const [{ worldCreateScene }, { getRequestRegistry }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/ops/world'),
    import('@/runtime/index')
  ])
  const driver = makeResponse([])

  let scenes = 0
  let unloads = 0
  const counting = {
    load: async () => {},
    unload: async () => {
      unloads++
    },
    step: async () => driver.response,
    createScene: async () => {
      scenes++
      return driver.response
    },
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(counting, async ({ modelId, session }) => {
    // Stand in for the staging file of a request that already holds the slot.
    fs.writeFileSync(session.stagingScenePath, 'another request is generating into this')

    const requestId = makeId('req')
    const stream = worldCreateScene({
      modelId,
      requestId,
      prompt: 'a scene',
      image: pngHeader()
    })
    getRequestRegistry().cancel({ requestId })

    await t.exception(stream.next(), /cancelled/i, 'the scene request rejects as a cancellation')
    t.is(scenes, 0, 'no native scene generation was dispatched')
    t.is(unloads, 0, 'the live session was not deactivated underneath its owner')
    t.ok(
      fs.existsSync(session.stagingScenePath),
      "the in-flight request's staging file was not discarded"
    )
    fs.unlinkSync(session.stagingScenePath)
  })
})

// The second guard: `deactivate()` awaits the session lock and any in-flight
// native job, so a cancel can land across it. `createScene` takes no abort
// predicate, so once dispatched it runs to completion whatever the caller does.
test('world scene op: a cancel during deactivate stops before native dispatch', async function (t) {
  const [{ worldCreateScene }, { getRequestRegistry }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/ops/world'),
    import('@/runtime/index')
  ])
  const driver = makeResponse([])
  const requestId = makeId('req')

  let scenes = 0
  const counting = {
    load: async () => {},
    // Fires while `deactivate()` is in progress, which is the only window this
    // second check exists for.
    unload: async () => {
      getRequestRegistry().cancel({ requestId })
    },
    step: async () => driver.response,
    createScene: async () => {
      scenes++
      return driver.response
    },
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(counting, async ({ modelId, session }) => {
    // Activate first, so `deactivate()` has real work to do and reaches unload().
    await session.ensureActivated()

    const stream = worldCreateScene({
      modelId,
      requestId,
      prompt: 'a scene',
      image: pngHeader()
    })

    await t.exception(stream.next(), /cancelled/i, 'the scene request rejects as a cancellation')
    t.is(scenes, 0, 'the cancel that landed during deactivate stopped the dispatch')
  })
})

// Promotion is not instantaneous: it awaits the session lock, a stat, a rename
// and optionally a whole readFile. A cancel accepted across any of those used to
// fall through to the terminal `done` payload and report success for a request
// the caller had already withdrawn.
test('world scene op: a cancel during promotion rejects instead of reporting done', async function (t) {
  const fs = await import('bare-fs')
  const [{ worldCreateScene }, { getRequestRegistry }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/ops/world'),
    import('@/runtime/index')
  ])
  const driver = makeResponse(['{"scene":"/server/path.safetensors","elapsed_ms":10}'])

  await withWorldSession(fakeNativeSession(driver.response), async ({ modelId, session }) => {
    const requestId = makeId('scene')

    // Deterministic gate on the real promotion, rather than racing a timer: the
    // cancel is issued while the genuine promoteStagedScene is in flight, so the
    // signal is set by the time it resolves. The session is a plain object, so
    // wrapping the method exercises the real code path either side of it.
    const promote = session.promoteStagedScene.bind(session)
    let promotions = 0
    session.promoteStagedScene = async (readBytes: boolean) => {
      promotions++
      const inFlight = promote(readBytes)
      getRequestRegistry().cancel({ requestId })
      return inFlight
    }

    fs.writeFileSync(session.stagingScenePath, 'a finished pack')

    const stream = worldCreateScene({
      modelId,
      requestId,
      prompt: 'a forest path',
      image: pngHeader()
    })

    const pending = stream.next()
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 20))
    driver.releaseStream()
    driver.settleJob()

    let terminal: IteratorResult<unknown> | undefined
    let threw: Error | undefined
    try {
      terminal = await pending
    } catch (error) {
      threw = error as Error
    }

    t.is(promotions, 1, 'promotion really did run, so the cancel landed across it')
    t.ok(threw, 'the withdrawn request rejects')
    t.absent(
      (terminal?.value as { done?: boolean } | undefined)?.done,
      'no terminal success payload is emitted for a cancelled scene'
    )
    // The rename already happened, so the world is real and the caller's
    // previous one is gone. Undoing it to honour a soft cancel would destroy a
    // valid world; the contract is that DELIVERY stops, not that the encode is
    // rolled back.
    t.ok(fs.existsSync(session.scenePath), 'the promoted world is left in place')
  })
})

// A compressed image's transfer size says nothing about its decoded size. The
// base64 ceiling bounds the wire; only the declared dimensions bound the
// allocation, and the native decoder reads them before any cover-scale or crop.
test('world scene op: a decompression bomb is refused before native dispatch', async function (t) {
  const { worldCreateScene } = await import('@/plugins/builtin/sdcpp-generation/ops/world')
  const driver = makeResponse([])

  let scenes = 0
  const counting = {
    load: async () => {},
    unload: async () => {},
    step: async () => driver.response,
    createScene: async () => {
      scenes++
      return driver.response
    },
    cancel: async () => {}
  } as unknown as NativeWorldSession

  // A minimal PNG header declaring 40000x40000 — 1.6 gigapixels, roughly 4.8 GB
  // once the native decoder expands it, from a payload of a few dozen bytes.

  await withWorldSession(counting, async ({ modelId }) => {
    const stream = worldCreateScene({
      modelId,
      requestId: makeId('scene'),
      prompt: 'a forest path',
      image: pngHeader(40000, 40000)
    })

    await t.exception(stream.next(), /over the .*-pixel ceiling/, 'the bomb is refused')
    t.is(scenes, 0, 'nothing reached the native decoder')
  })
})

// The check is a pure input precondition, so it has to run BEFORE the
// deactivate() that replaces the caller's world. Rejecting a request after
// tearing down the session it never touched costs a live walker its session and
// a full multi-second re-activation on the next step.
test('world scene op: a rejected first frame does not cost the caller their session', async function (t) {
  const { worldCreateScene } = await import('@/plugins/builtin/sdcpp-generation/ops/world')
  const driver = makeResponse([])

  let unloads = 0
  const counting = {
    load: async () => {},
    unload: async () => {
      unloads++
    },
    step: async () => driver.response,
    createScene: async () => driver.response,
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(counting, async ({ modelId, session }) => {
    await session.ensureActivated()
    t.is(unloads, 0, 'the session is live before the rejected request')

    const stream = worldCreateScene({
      modelId,
      requestId: makeId('scene'),
      prompt: 'a forest path',
      image: pngHeader(40000, 40000)
    })
    await t.exception(stream.next(), /over the .*-pixel ceiling/, 'the request is refused')

    t.is(unloads, 0, 'a pure validation failure did not tear the live session down')
  })
})

test('world scene op: a normal first frame is unaffected by the pixel guard', async function (t) {
  const { worldCreateScene } = await import('@/plugins/builtin/sdcpp-generation/ops/world')
  const driver = makeResponse([])

  let scenes = 0
  const counting = {
    load: async () => {},
    unload: async () => {},
    step: async () => driver.response,
    createScene: async () => {
      scenes++
      return driver.response
    },
    cancel: async () => {}
  } as unknown as NativeWorldSession

  // A 12 MP camera photo — 4000x3000, the realistic worst case a caller sends
  // for an 832x480 world. It is cover-scaled and cropped, so it must pass.

  await withWorldSession(counting, async ({ modelId, session }) => {
    const stream = worldCreateScene({
      modelId,
      requestId: makeId('scene'),
      prompt: 'a forest path',
      image: pngHeader(4000, 3000)
    })
    const pending = stream.next()
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 20))
    driver.releaseStream()
    driver.settleJob()
    await pending.catch(() => {})
    await stream.return(undefined).catch(() => {})

    t.is(scenes, 1, 'a 12 MP camera photo still reaches the native decoder')
    await session.discardStagedScene()
  })
})

// The guard fails CLOSED. Failing open on an unreadable header would make the
// pixel ceiling skippable by simply sending another format — the sender picks
// it — so anything that cannot be sized is refused. The schema documents
// PNG/JPEG, so this enforces what is already published.
test('world scene op: an unreadable image header is refused, not waved through', async function (t) {
  const [{ worldCreateScene }, { readImageDimensions }] = await Promise.all([
    import('@/plugins/builtin/sdcpp-generation/ops/world'),
    import('@/utils/index')
  ])
  const driver = makeResponse([])

  t.is(readImageDimensions(Buffer.from('BM' + 'x'.repeat(40))), null, 'a BMP magic reads as null')
  t.is(readImageDimensions(Buffer.alloc(2)), null, 'a runt buffer reads as null')
  t.is(readImageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null, 'a truncated PNG header')

  let scenes = 0
  const counting = {
    load: async () => {},
    unload: async () => {},
    step: async () => driver.response,
    createScene: async () => {
      scenes++
      return driver.response
    },
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(counting, async ({ modelId }) => {
    const stream = worldCreateScene({
      modelId,
      requestId: makeId('scene'),
      prompt: 'a forest path',
      // A BMP carrying the same gigapixel payload the PNG bomb does. Fail-open
      // would have let exactly this through.
      image: Buffer.from('BM' + 'x'.repeat(200)).toString('base64')
    })

    await t.exception(stream.next(), /not a readable PNG or JPEG/, 'the unsized frame is refused')
    t.is(scenes, 0, 'nothing reached the native decoder')
  })
})

// JPEG allows any run of 0xFF fill bytes before a marker (ITU-T T.81 B.1.1.2).
// Reading a fill byte AS the marker desynchronises the segment walk and returns
// null — which, once the guard fails closed, turns a valid photo into a refusal.
test('image dimensions: a JPEG with fill bytes before its SOF still reads', async function (t) {
  const { readImageDimensions } = await import('@/utils/index')

  // SOI, an APP0-shaped segment, then TWO fill bytes ahead of the SOF0 marker.
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xff, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02,
    0x58, 0x01, 0xc0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01
  ])

  t.alike(
    readImageDimensions(jpeg),
    { width: 448, height: 600 },
    'the fill bytes are skipped rather than parsed as a marker'
  )
})

test('world scene op: a dispatch that never starts leaves no staged file behind', async function (t) {
  const fs = await import('bare-fs')
  const { worldCreateScene } = await import('@/plugins/builtin/sdcpp-generation/ops/world')
  const driver = makeResponse([])

  // The native side can write a partial pack and then fail, so the guard has to
  // wrap the dispatch itself — not just the stream that follows it.
  const failing = {
    load: async () => {},
    unload: async () => {},
    step: async () => driver.response,
    createScene: async () => {
      throw new Error('native scene dispatch failed')
    },
    cancel: async () => {}
  } as unknown as NativeWorldSession

  await withWorldSession(failing, async ({ modelId, session }) => {
    fs.writeFileSync(session.stagingScenePath, 'a partial pack the native side left')

    const stream = worldCreateScene({
      modelId,
      requestId: makeId('req'),
      prompt: 'a scene',
      image: pngHeader()
    })

    await t.exception(
      stream.next(),
      /native scene dispatch failed/,
      'the failure reaches the caller'
    )
    t.absent(
      fs.existsSync(session.stagingScenePath),
      'the staged file is dropped rather than left for the next run to promote'
    )
  })
})

test('world scene op: abandoning the generator drops the staged file', async function (t) {
  const fs = await import('bare-fs')
  const { worldCreateScene } = await import('@/plugins/builtin/sdcpp-generation/ops/world')
  const driver = makeResponse([])

  await withWorldSession(fakeNativeSession(driver.response), async ({ modelId, session }) => {
    fs.writeFileSync(session.stagingScenePath, 'a generation in progress')

    const stream = worldCreateScene({
      modelId,
      requestId: makeId('req'),
      prompt: 'a scene',
      image: pngHeader()
    })
    const pending = stream.next()

    // A consumer walking away unwinds as a RETURN completion, so a `catch` never
    // sees it — only a `finally` does. That is the path this covers.
    const returning = stream.return(undefined)
    driver.releaseStream()
    driver.settleJob()
    await returning.catch(() => {})
    await pending.catch(() => {})

    t.absent(
      fs.existsSync(session.stagingScenePath),
      'an abandoned generation does not leave its staged pack on disk'
    )
  })
})

test('world session: an oversized pack is refused and the existing world survives', async function (t) {
  const [fsMod, { getEngineLogger }, worldOps] = await Promise.all([
    import('bare-fs'),
    import('@/logging/index'),
    import('@/plugins/builtin/sdcpp-generation/ops/world')
  ])
  const driver = makeResponse([])

  const modelId = makeId('test-world-oversized')
  const session = worldOps.createWorldSession({
    modelId,
    files: {
      model: '/tmp/dit.gguf',
      taehv: '/tmp/taehv.gguf',
      scene: worldOps.worldScenePath(modelId)
    },
    config: {},
    encoders: { t5: '/tmp/t5.gguf', vae: '/tmp/vae.gguf' },
    logger: getEngineLogger(),
    world: fakeNativeSession(driver.response),
    // The real ceiling is 128 MB; a test has no business writing that.
    maxScenePackBytes: 16
  })

  try {
    fsMod.default.writeFileSync(session.scenePath, 'the world the caller already had')
    fsMod.default.writeFileSync(session.stagingScenePath, 'a pack far past the ceiling')

    await t.exception(
      session.promoteStagedScene(false),
      /over the 16-byte ceiling/,
      'an implausible pack is refused'
    )
    // Sized BEFORE the rename, so the caller keeps the world they had rather
    // than having it replaced by something the worker would not hand back.
    t.is(
      fsMod.default.readFileSync(session.scenePath, 'utf8'),
      'the world the caller already had',
      'the existing valid world is left in place'
    )
  } finally {
    try {
      fsMod.default.unlinkSync(session.scenePath)
    } catch {}
    try {
      fsMod.default.unlinkSync(session.stagingScenePath)
    } catch {}
  }
})

test('world session: teardown waits for a job that is still being admitted', async function (t) {
  const driver = makeResponse([])
  let nativeUnloaded = false
  let admit = () => {}
  const admission = new Promise<void>((resolve) => {
    admit = resolve
  })

  await withWorldSession(
    fakeNativeSession(driver.response, async () => {
      nativeUnloaded = true
    }),
    async ({ session }) => {
      // The window this covers is dispatch itself: the native scheduler has
      // been called but has not handed back a job handle yet. Tracking the job
      // only after that returns leaves teardown believing nothing is running.
      const running = session.run(async () => {
        await admission
        return driver.response
      })

      let unloadDone = false
      const unloading = session.unload().then(() => {
        unloadDone = true
      })

      await new Promise<void>((resolve) => setTimeout(() => resolve(), 50))
      t.absent(unloadDone, 'unload does not return while a job is still being admitted')
      t.absent(nativeUnloaded, 'native teardown is not entered during admission')

      admit()
      await running
      driver.settleJob()
      await unloading
      t.ok(nativeUnloaded, 'native teardown runs once the admitted job has settled')
    }
  )
})

test('world session: a torn-down session refuses new work instead of driving dead native state', async function (t) {
  const driver = makeResponse([])

  await withWorldSession(fakeNativeSession(driver.response), async ({ session }) => {
    await session.unload()

    await t.exception(
      session.run(async () => driver.response),
      /is not loaded/,
      'dispatch after teardown is refused rather than reaching the native session'
    )
    await t.exception(
      session.ensureActivated(),
      /is not loaded/,
      'activation after teardown is refused too'
    )
  })
})

test('world session: promotion after teardown fails as an unloaded model, not a missing file', async function (t) {
  const fsPromises = (await import('bare-fs')).promises
  const driver = makeResponse([])

  await withWorldSession(fakeNativeSession(driver.response), async ({ session }) => {
    // A generation that finished natively but has not been promoted yet.
    await fsPromises.writeFile(session.stagingScenePath, 'staged')
    await session.unload()

    // Without the liveness check this surfaces as a bare ENOENT from rename —
    // an unexplained filesystem error for what is really "you unloaded the
    // model while its world was being created".
    await t.exception(
      session.promoteStagedScene(true),
      /is not loaded/,
      'promotion reports the real cause once the session is gone'
    )
  })
})
