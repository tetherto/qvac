import test from 'brittle'
import fs from 'bare-fs'
import type {
  NativeWorldSession,
  WorldSession
} from '@/server/bare/plugins/sdcpp-generation/ops/world'

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}-${Date.now()}`
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
  const [{ registerModel, unregisterModel }, { ModelType }, worldOps, { getServerLogger }] =
    await Promise.all([
      import('@/server/bare/registry/model-registry'),
      import('@/schemas'),
      import('@/server/bare/plugins/sdcpp-generation/ops/world'),
      import('@/logging')
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
    logger: getServerLogger(),
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

      await new Promise((resolve) => setTimeout(resolve, 50))
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
    import('@/server/bare/plugins/sdcpp-generation/ops/world'),
    import('@/server/bare/runtime')
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

    // The DiT already committed this block, so the undelivered frames are
    // gone and the walk resumes past them. Reporting `done` here would hand
    // the caller a silent gap dressed as success.
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

test('world scene op: the model slot is held until uninterruptible work settles', async function (t) {
  const [{ worldCreateScene }, { getRequestRegistry }, { RequestRejectedByPolicyError }] =
    await Promise.all([
      import('@/server/bare/plugins/sdcpp-generation/ops/world'),
      import('@/server/bare/runtime'),
      import('@/utils/errors-server')
    ])
  const driver = makeResponse(['{"scene":"/server/path.safetensors","elapsed_ms":10}'])

  await withWorldSession(fakeNativeSession(driver.response), async ({ modelId }) => {
    const stream = worldCreateScene({
      modelId,
      requestId: makeId('scene'),
      prompt: 'a forest path',
      image: Buffer.from([1, 2, 3]).toString('base64')
    })

    // Start the op, then abandon the consumer mid-encode. The native encode
    // takes no abort predicate, so it runs on regardless — which is exactly
    // the case the slot must survive.
    const pending = stream.next()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const returning = stream.return(undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))

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
    await new Promise((resolve) => setTimeout(resolve, 50))

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
    import('@/server/bare/plugins/sdcpp-generation/ops/world'),
    import('@/server/bare/runtime')
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
    import('@/server/bare/plugins/sdcpp-generation/ops/world'),
    import('@/server/bare/runtime'),
    import('@/utils/errors-server')
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
    import('@/server/bare/plugins/sdcpp-generation/ops/world'),
    import('@/server/bare/runtime')
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
  const { worldStep } = await import('@/server/bare/plugins/sdcpp-generation/ops/world')

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
  const { worldStep } = await import('@/server/bare/plugins/sdcpp-generation/ops/world')

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

test('world scene op: a dispatch that never starts leaves no staged file behind', async function (t) {
  const fs = await import('bare-fs')
  const { worldCreateScene } = await import('@/server/bare/plugins/sdcpp-generation/ops/world')
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
      image: Buffer.from('image').toString('base64')
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
  const { worldCreateScene } = await import('@/server/bare/plugins/sdcpp-generation/ops/world')
  const driver = makeResponse([])

  await withWorldSession(fakeNativeSession(driver.response), async ({ modelId, session }) => {
    fs.writeFileSync(session.stagingScenePath, 'a generation in progress')

    const stream = worldCreateScene({
      modelId,
      requestId: makeId('req'),
      prompt: 'a scene',
      image: Buffer.from('image').toString('base64')
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
  const [fsMod, { getServerLogger }, worldOps] = await Promise.all([
    import('bare-fs'),
    import('@/logging'),
    import('@/server/bare/plugins/sdcpp-generation/ops/world')
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
    logger: getServerLogger(),
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

      await new Promise((resolve) => setTimeout(resolve, 50))
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
