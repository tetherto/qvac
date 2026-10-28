import test from 'brittle'
import Buffer from 'bare-buffer'
import { setImmediate } from 'bare-timers'
import { diffusion } from '@/plugins/builtin/sdcpp-generation/ops/diffusion'
import { getRequestRegistry, type RequestContext } from '@/runtime'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { InferenceCancelledError } from '@/errors'
import { diffusion as generateImage } from '@/api/diffusion'
import { close } from '@/dispatch'
import { registerPlugin } from '@/plugins'
import { useTestCacheDir } from './fixtures/test-cache'
import type { DiffusionStreamResponse } from '@/schemas/sdcpp-config'

const nativeCancelled = new Error('native generation was cancelled')

for (const phase of ['run', 'iterate'] as const) {
  test(`diffusion records a native ${phase} failure as failed`, async (t) => {
    const modelId = `diffusion-failed-${phase}`
    const failure = new Error(`native ${phase} failed`)
    let context: RequestContext | undefined
    registerModel(modelId, {
      model: {
        cancel: async () => {},
        run: async () => {
          context = getRequestRegistry()
            .list()
            .find((ctx) => ctx.modelId === modelId)
          if (phase === 'run') throw failure
          return {
            iterate: async function* () {
              yield '{"step":1,"total":2}'
              throw failure
            },
            await: async () => {
              throw failure
            }
          }
        }
      } as never,
      path: '/models/test.gguf',
      config: {},
      modelType: 'sdcpp-generation'
    })
    const stream = diffusion({ modelId, prompt: 'A portrait.' })
    try {
      if (phase === 'iterate') await stream.next()
      const error = await stream.next().catch((error: unknown) => error)
      t.is(error, failure, 'preserve the original failure')
      t.is(context?.state, 'failed', 'record the failed lifecycle outcome')
      t.absent(
        getRequestRegistry()
          .list()
          .find((ctx) => ctx.modelId === modelId)
      )
    } finally {
      await stream.return(undefined as never)
      unregisterModel(modelId)
    }
  })
}

test('diffusion outputs allow an immediate next generation on the same model', async (t) => {
  const { diffusionPlugin } = await import('@/plugins/builtin/sdcpp-generation/plugin')
  useTestCacheDir()
  registerPlugin(diffusionPlugin)
  const modelId = 'diffusion-sequential-outputs'
  const image = Buffer.from([137, 80, 78, 71])
  let cancelCalls = 0
  registerModel(modelId, {
    model: {
      cancel: async () => {
        cancelCalls++
      },
      run: async () => ({
        iterate: async function* () {
          yield image
        }
      })
    } as never,
    path: '/models/qwen.gguf',
    config: {},
    modelType: 'sdcpp-generation'
  })
  try {
    const outputs: Uint8Array[][] = []
    for (let i = 0; i < 4; i++) {
      outputs.push(await generateImage({ modelId, prompt: 'A portrait.' }).outputs)
    }
    t.alike(
      outputs.map((images) => images.map((bytes) => Array.from(bytes))),
      Array.from({ length: 4 }, () => [Array.from(image)])
    )
    t.is(cancelCalls, 0, 'completed jobs do not trigger native cancellation')
    t.is(
      getRequestRegistry()
        .list()
        .filter((ctx) => ctx.modelId === modelId).length,
      0
    )
  } finally {
    unregisterModel(modelId)
    await close()
  }
})

test('diffusion cancellation calls model.cancel and rejects without returning an image', async (t) => {
  const modelId = 'diffusion-cancel-regression'
  let cancelCalls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  registerModel(modelId, {
    model: {
      cancel: async () => {
        cancelCalls++
        release()
      },
      run: async () => ({
        await: async () => {
          await gate
          if (cancelCalls > 0) throw nativeCancelled
        },
        iterate: async function* () {
          yield '{"step":1,"total":30,"elapsed_ms":10}'
          await gate
          if (cancelCalls > 0) throw nativeCancelled
          yield Buffer.from([137, 80, 78, 71])
        }
      })
    } as never,
    path: '/models/qwen.gguf',
    config: {},
    modelType: 'sdcpp-generation'
  })
  const stream = diffusion({ modelId, prompt: 'A portrait.' })
  try {
    const first = await stream.next()
    t.is(first.done, false)
    if (!first.done) t.is(first.value.step, 1)
    const contexts = getRequestRegistry()
      .list()
      .filter((ctx) => ctx.modelId === modelId)
    t.is(contexts.length, 1, 'the active generation is visible to broad cancellation')
    t.is(getRequestRegistry().cancel({ modelId, kind: 'diffusion' }), 1)
    t.is(cancelCalls, 1, 'abort reaches the native job')
    release()
    try {
      await stream.next()
      t.fail('expected a typed cancellation instead of an image or success marker')
    } catch (error) {
      t.ok(error instanceof InferenceCancelledError)
      t.is((error as Error).cause, nativeCancelled, 'preserve the native cancellation cause')
    }
    t.is(contexts[0]?.state, 'cancelled', 'keep cancellation distinct from failure')
    t.is(
      getRequestRegistry()
        .list()
        .filter((ctx) => ctx.modelId === modelId).length,
      0
    )
  } finally {
    release()
    await stream.return(undefined as never)
    unregisterModel(modelId)
  }
})

test('diffusion suppresses a late image when native cancellation finishes normally', async (t) => {
  const modelId = 'diffusion-cancel-late-image'
  registerModel(modelId, {
    model: {
      cancel: async () => {},
      run: async () => ({
        iterate: async function* () {
          yield '{"step":1,"total":2}'
          yield Buffer.from([137, 80, 78, 71])
        }
      })
    } as never,
    path: '/models/qwen.gguf',
    config: {},
    modelType: 'sdcpp-generation'
  })
  try {
    const stream = diffusion({ modelId, prompt: 'A portrait.' })
    await stream.next()
    getRequestRegistry().cancel({ modelId, kind: 'diffusion' })
    await t.exception(() => stream.next(), /cancel/i)
    const next = diffusion({ modelId, prompt: 'Another portrait.' })
    const chunks = []
    for await (const chunk of next) chunks.push(chunk)
    t.is(chunks.length, 2, 'a new request succeeds after cancellation')
    t.is(chunks[0]?.step, 1)
    t.is(chunks[1]?.data, Buffer.from([137, 80, 78, 71]).toString('base64'))
  } finally {
    unregisterModel(modelId)
  }
})

test('diffusion early consumer exit cancels and settles before releasing admission', async (t) => {
  const { diffusionPlugin } = await import('@/plugins/builtin/sdcpp-generation/plugin')
  const modelId = 'diffusion-early-exit'
  let cancelCalls = 0
  let settleStarted: () => void = () => {}
  let release: () => void = () => {}
  const settling = new Promise<void>((resolve) => {
    settleStarted = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  registerModel(modelId, {
    model: {
      cancel: async () => {
        cancelCalls++
      },
      run: async () => ({
        iterate: async function* () {
          yield '{"step":1,"total":2}'
        },
        await: async () => {
          settleStarted()
          await gate
        }
      })
    } as never,
    path: '/models/qwen.gguf',
    config: {},
    modelType: 'sdcpp-generation'
  })
  const stream = diffusionPlugin.handlers.diffusionStream.handler({
    modelId,
    prompt: 'A portrait.',
    img_cfg_scale: -1
  }) as AsyncGenerator<DiffusionStreamResponse>
  try {
    await stream.next()
    const closing = stream.return(undefined as never)
    await settling
    t.is(cancelCalls, 1)
    const concurrent = diffusion({ modelId, prompt: 'Another portrait.' })
    await t.exception(() => concurrent.next(), /policy/i)
    release()
    await closing
    t.is(
      getRequestRegistry()
        .list()
        .filter((ctx) => ctx.modelId === modelId).length,
      0
    )
  } finally {
    release()
    await stream.return(undefined as never)
    unregisterModel(modelId)
  }
})

test('diffusion cancellation interrupts a pending model.run and preserves its failure', async (t) => {
  const modelId = 'diffusion-cancel-pending-run'
  let cancelCalls = 0
  let started: () => void = () => {}
  let release: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  registerModel(modelId, {
    model: {
      cancel: async () => {
        cancelCalls++
        release()
      },
      run: async () => {
        started()
        await gate
        throw nativeCancelled
      }
    } as never,
    path: '/models/qwen.gguf',
    config: {},
    modelType: 'sdcpp-generation'
  })
  const stream = diffusion({ modelId, prompt: 'A portrait.' })
  const result = stream.next().catch((error: unknown) => error)
  try {
    await running
    t.is(getRequestRegistry().cancel({ modelId, kind: 'diffusion' }), 1)
    t.is(cancelCalls, 1, 'cancel is available before model.run returns a response')
    release()
    const error = await result
    t.ok(error instanceof InferenceCancelledError)
    t.is((error as Error).cause, nativeCancelled)
    t.is(
      getRequestRegistry()
        .list()
        .filter((ctx) => ctx.modelId === modelId).length,
      0
    )
  } finally {
    release()
    await result
    await stream.return(undefined as never)
    unregisterModel(modelId)
  }
})

for (const nativeFails of [false, true]) {
  test(`diffusion retains admission during delayed cancel when native iteration ${nativeFails ? 'fails' : 'finishes'}`, async (t) => {
    const modelId = `diffusion-cancel-delayed-${nativeFails}`
    const image = Buffer.from([137, 80, 78, 71])
    let cancelCalls = 0
    let runCalls = 0
    let settling: () => void = () => {}
    let release: () => void = () => {}
    const cleanupStarted = new Promise<void>((resolve) => {
      settling = resolve
    })
    const cancelGate = new Promise<void>((resolve) => {
      release = resolve
    })
    registerModel(modelId, {
      model: {
        cancel: async () => {
          cancelCalls++
          await cancelGate
        },
        run: async () => {
          const first = ++runCalls === 1
          return {
            iterate: async function* () {
              if (first) {
                yield '{"step":1,"total":2}'
                if (nativeFails) throw nativeCancelled
                yield image
                settling()
                return
              }
              yield image
            },
            await: async () => {
              if (first && nativeFails) {
                settling()
                throw nativeCancelled
              }
              return [image]
            }
          }
        }
      } as never,
      path: '/models/qwen.gguf',
      config: {},
      modelType: 'sdcpp-generation'
    })
    const stream = diffusion({ modelId, prompt: 'A portrait.' })
    try {
      await stream.next()
      t.is(getRequestRegistry().cancel({ modelId, kind: 'diffusion' }), 1)
      let settled = false
      const result = stream
        .next()
        .catch((error: unknown) => error)
        .then((value: unknown) => {
          settled = true
          return value
        })
      await cleanupStarted
      await new Promise<void>((resolve) => setImmediate(resolve))
      t.is(settled, false, 'the stream waits for native cancellation to settle')
      t.is(cancelCalls, 1, 'abort and stream cleanup share one native cancellation')
      const concurrent = diffusion({ modelId, prompt: 'Too soon.' })
      await t.exception(() => concurrent.next(), /policy/i)
      t.is(runCalls, 1, 'admission blocks another native run while cancel is pending')
      release()
      const error = await result
      t.ok(error instanceof InferenceCancelledError)
      if (nativeFails) t.is((error as Error).cause, nativeCancelled)
      const chunks = []
      for await (const chunk of diffusion({ modelId, prompt: 'After cancellation.' })) {
        chunks.push(chunk)
      }
      t.is(chunks[0]?.data, image.toString('base64'))
      t.is(chunks.length, 1, 'the op returns without yielding a terminal frame')
      t.is(runCalls, 2)
      t.is(cancelCalls, 1, 'the completed follow-up request does not cancel')
    } finally {
      release()
      await stream.return(undefined as never)
      unregisterModel(modelId)
    }
  })
}
