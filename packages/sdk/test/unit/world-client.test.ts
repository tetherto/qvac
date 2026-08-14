import test from 'brittle'
import {
  createWorldSceneResult,
  createWorldStepResult,
  toWalkKeys
} from '@/client/api/world-result'
import { encodeBase64 } from '@/utils/encoding'

function frame(byte: number) {
  return encodeBase64(new Uint8Array([byte, byte, byte]))
}

test('toWalkKeys: accepts arrays, key objects and raw masks', (t) => {
  t.alike(toWalkKeys(['W']), ['W'], 'array')
  t.alike(toWalkKeys({ W: true, L: true }), ['W', 'L'], 'key-state object')
  t.alike(toWalkKeys(0b00000001), ['W'], 'mask bit 0')
  t.alike(toWalkKeys(0b10000000), ['L'], 'mask bit 7')
  t.alike(toWalkKeys(0b11111111), ['W', 'A', 'S', 'D', 'I', 'J', 'K', 'L'], 'every bit')
  t.alike(toWalkKeys(0), [], 'empty mask idles')
  t.alike(toWalkKeys(undefined), [], 'omitted keys idle')
})

test('toWalkKeys: unheld object entries are dropped', (t) => {
  t.alike(toWalkKeys({ W: true, S: false, L: undefined }), ['W'], 'only held keys survive')
})

test('toWalkKeys: folds case and normalizes to bit order', (t) => {
  t.alike(toWalkKeys(['w', 'l']), ['W', 'L'], 'lowercase is accepted')
  // Same held set, three orderings, one canonical request — so an identical
  // block is never sent as three different payloads.
  t.alike(toWalkKeys(['L', 'W']), ['W', 'L'], 'reordered')
  t.alike(toWalkKeys(['W', 'L', 'W']), ['W', 'L'], 'duplicates collapse')
})

test('toWalkKeys: rejects unmapped keys and out-of-range masks', (t) => {
  t.exception(() => toWalkKeys(['Q']), /unknown walk key/, 'unmapped key')
  t.exception(() => toWalkKeys(256), /\[0, 255\]/, 'mask above a byte')
  t.exception(() => toWalkKeys(-1), /\[0, 255\]/, 'negative mask')
  t.exception(() => toWalkKeys(1.5), /\[0, 255\]/, 'non-integer mask')
})

test('worldStep result: frames stream as they arrive and collect into the block', async (t) => {
  async function* stubStream() {
    yield { type: 'worldStepStream', data: frame(1), frameIndex: 0 }
    yield { type: 'worldStepStream', data: frame(2), frameIndex: 1 }
    yield {
      type: 'worldStepStream',
      done: true,
      step: 3,
      frames: 2,
      elapsedMs: 1780,
      stats: { stepMs: 1780, totalSteps: 3, frames: 2, width: 832, height: 480 }
    }
  }

  const result = createWorldStepResult({ modelId: 'm', keys: ['W'] }, stubStream)

  const streamed: number[] = []
  for await (const f of result.frameStream) streamed.push(f[0]!)

  t.alike(streamed, [1, 2], 'every frame is yielded incrementally')
  t.is((await result.frames).length, 2, 'the block collects the same frames')
  t.is((await result.stats)?.totalSteps, 3, 'stats come through')
  t.ok(result.requestId.length > 0, 'exposes a requestId for cancel()')
})

test('worldStep result: a mid-stream failure reaches both the stream and the promises', async (t) => {
  async function* failingStream() {
    yield { type: 'worldStepStream', data: frame(1), frameIndex: 0 }
    throw new Error('Job cancelled')
  }

  const result = createWorldStepResult({ modelId: 'm' }, failingStream)

  await t.exception(
    (async () => {
      for await (const _ of result.frameStream) {
        // drain until it throws
      }
    })(),
    /Job cancelled/,
    'frameStream surfaces the failure'
  )
  await t.exception(result.frames, /Job cancelled/, 'the block promise rejects')
  await t.exception(result.stats, /Job cancelled/, 'stats reject rather than hang')
})

test('worldStep result: unrelated stream payloads are ignored', async (t) => {
  async function* noisyStream() {
    yield { type: 'somethingElse', data: frame(9) }
    yield { type: 'worldStepStream', data: frame(1), frameIndex: 0 }
    yield { type: 'worldStepStream', done: true }
  }

  const result = createWorldStepResult({ modelId: 'm' }, noisyStream)
  t.is((await result.frames).length, 1, 'only worldStepStream frames are collected')
})

test('worldCreateScene result: resolves the pack and its stats', async (t) => {
  const pack = encodeBase64(new Uint8Array([1, 2, 3, 4]))
  async function* stubStream() {
    yield {
      type: 'worldSceneStream',
      data: pack,
      elapsedMs: 4200,
      done: true,
      stats: { sceneCreateMs: 4200, width: 832, height: 480 }
    }
  }

  const result = createWorldSceneResult(
    { modelId: 'm', prompt: '| unknown | a forest path', image: new Uint8Array([7, 7]) },
    stubStream
  )

  t.is((await result.scene).length, 4, 'the scene pack comes back to the caller')
  t.is((await result.stats)?.sceneCreateMs, 4200, 'stats come through')
})

test('worldCreateScene result: finishing without a pack rejects rather than resolving empty', async (t) => {
  async function* emptyStream() {
    yield { type: 'worldSceneStream', done: true }
  }

  const result = createWorldSceneResult(
    { modelId: 'm', prompt: 'a scene', image: new Uint8Array([7]) },
    emptyStream
  )

  await t.exception(result.scene, /without returning a pack/, 'no silent empty pack')
})

test('worldCreateScene result: a stream failure rejects the pack', async (t) => {
  async function* failingStream() {
    yield { type: 'worldSceneStream' }
    throw new Error('Model was unloaded')
  }

  const result = createWorldSceneResult(
    { modelId: 'm', prompt: 'a scene', image: new Uint8Array([7]) },
    failingStream
  )

  await t.exception(result.scene, /Model was unloaded/)
  await t.exception(result.stats, /Model was unloaded/)
})

// A stream can end cleanly without ever carrying `done` — a dropped transport,
// a worker that goes away, a server-side abort that closes rather than throws.
// Nothing else settles the result promises, so leaving them pending turns that
// into an await that never returns: indistinguishable from slow generation, and
// impossible for the caller to time out because no error is ever delivered.
test('worldStep result: a stream that ends without done rejects instead of hanging', async (t) => {
  async function* truncatedStream() {
    yield { type: 'worldStepStream', data: frame(1), frameIndex: 0 }
  }

  const result = createWorldStepResult({ modelId: 'm', keys: ['W'] }, truncatedStream)

  await t.exception(result.frames, /ended before the operation completed/, 'frames do not hang')
  await t.exception(result.stats, /ended before the operation completed/, 'stats do not hang')
})

test('worldStep result: a truncated block surfaces on the frame stream too', async (t) => {
  async function* truncatedStream() {
    yield { type: 'worldStepStream', data: frame(1), frameIndex: 0 }
  }

  const result = createWorldStepResult({ modelId: 'm', keys: ['W'] }, truncatedStream)

  const streamed: number[] = []
  await t.exception(
    (async () => {
      for await (const f of result.frameStream) streamed.push(f[0]!)
    })(),
    /ended before the operation completed/,
    'a partial block is an error, not a short but successful walk'
  )
  t.alike(streamed, [1], 'frames delivered before the truncation are still handed over')
})

// The world ops throw InferenceCancelledError server-side, so it crosses the RPC
// envelope and arrives as a generic RPCError carrying the code. Without the
// client-side rebuild, `instanceof InferenceCancelledError` fails and a caller
// cannot tell a cancelled walk from a failed one.
test('worldStep result: a server cancellation is rebuilt as InferenceCancelledError', async (t) => {
  const { InferenceCancelledError } = await import('@/utils/errors-server')
  const { SDK_SERVER_ERROR_CODES } = await import('@/schemas/sdk-errors-server')

  async function* cancelledStream() {
    yield { type: 'worldStepStream', data: frame(1), frameIndex: 0 }
    const wire = new Error('Inference cancelled') as Error & { code: number }
    wire.code = SDK_SERVER_ERROR_CODES.INFERENCE_CANCELLED
    throw wire
  }

  const result = createWorldStepResult({ modelId: 'm', keys: ['W'] }, cancelledStream)

  const error = await result.frames.then(
    () => null,
    (e: unknown) => e
  )
  t.ok(error instanceof InferenceCancelledError, 'the typed class survives the wire')
  t.is(
    (error as InstanceType<typeof InferenceCancelledError>).requestId,
    result.requestId,
    'and carries the requestId the caller cancelled with'
  )
})

test('worldStep result: a non-cancel failure is left alone', async (t) => {
  const { InferenceCancelledError } = await import('@/utils/errors-server')

  async function* failingStream() {
    yield { type: 'worldStepStream', data: frame(1), frameIndex: 0 }
    throw new Error('CUDA out of memory')
  }

  const result = createWorldStepResult({ modelId: 'm', keys: ['W'] }, failingStream)

  const error = await result.frames.then(
    () => null,
    (e: unknown) => e
  )
  t.absent(error instanceof InferenceCancelledError, 'an unrelated failure is not relabelled')
  t.ok(/out of memory/.test(String(error)), 'and keeps its own message')
})

test('worldCreateScene result: a stream that ends without done rejects instead of hanging', async (t) => {
  async function* truncatedStream() {
    yield { type: 'worldSceneStream' }
  }

  const result = createWorldSceneResult(
    { modelId: 'm', prompt: 'a scene', image: new Uint8Array([7]) },
    truncatedStream
  )

  await t.exception(result.scene, /ended before the operation completed/, 'the pack does not hang')
  await t.exception(result.stats, /ended before the operation completed/, 'stats do not hang')
})
