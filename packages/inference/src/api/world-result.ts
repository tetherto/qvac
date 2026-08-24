import {
  MAX_SCENE_IMAGE_BYTES,
  walkKeySchema,
  worldSceneStreamRequestSchema,
  worldSceneStreamResponseSchema,
  worldStepStreamRequestSchema,
  worldStepStreamResponseSchema,
  type WalkKey,
  type WalkKeysInput,
  type WorldSceneClientParams,
  type WorldSceneStats,
  type WorldSceneStreamRequest,
  type WorldStepClientParams,
  type WorldStepStats,
  type WorldStepStreamRequest
} from '@/schemas/sdcpp-config'
import { parseClientInput } from '@/api/parse-input'
import { generateRequestId } from '@/runtime/request-id'
import { decodeBase64, encodeBase64 } from '@/utils/encoding'
import {
  InvalidResponseError,
  RequestValidationFailedError,
  StreamEndedError,
  InferenceCancelledError
} from '@/errors/index'

import { ERROR_CODES } from '@/schemas/errors'

export type WorldStepStreamFactory = (request: WorldStepStreamRequest) => AsyncGenerator<unknown>

export type WorldSceneStreamFactory = (request: WorldSceneStreamRequest) => AsyncGenerator<unknown>

/** Mirrors `VideoProgressTick` / `DiffusionProgressTick`. */
export interface WorldStepProgressTick {
  /** Blocks completed on this session, as the engine counts them. */
  step: number
  /**
   * Frames DELIVERED by the block that just finished — a final count, since the
   * engine emits this after the frames rather than during. Named `totalSteps`
   * only to keep the wire shape identical to `video` and `diffusion`.
   */
  totalSteps: number
  elapsedMs: number
}

export interface WorldStepResult {
  requestId: string
  /** Frames of this block, yielded as the transport delivers them. */
  frameStream: AsyncGenerator<Uint8Array>
  /**
   * The engine's own tick for each completed block, forwarded verbatim — the
   * same field shape `video` and `diffusion` expose.
   *
   * NOT mid-block liveness, and it cannot be. `WorldSessionModel.cpp` runs the
   * block to completion, delivers every frame, and only then fires its progress
   * callback: exactly one tick per block, after the frames. So this yields once
   * per `worldStep`, at the end. Use it to report what a block did; a "still
   * working" signal during the 1.8-7.5s a block takes needs an addon change.
   */
  progressStream: AsyncGenerator<WorldStepProgressTick>
  /** Every frame of the block, once it completes. */
  frames: Promise<Uint8Array[]>
  stats: Promise<WorldStepStats | undefined>
}

/**
 * Completion of a scene creation. The world is live on the session either way —
 * `stats` is what tells you it finished.
 */
export interface WorldSceneResult {
  requestId: string
  stats: Promise<WorldSceneStats | undefined>
}

/**
 * What `worldCreateScene({ returnPack: true })` returns. `scene` exists only on
 * this shape, so the bytes cannot be awaited on a request that never asked for
 * them — the alternative, a `Promise<Uint8Array | undefined>` on one shared
 * type, pushes that check to every caller and hides it from the compiler.
 *
 * Save the bytes to walk the world again: pass the file back as
 * `modelConfig.sceneSrc` on a later `loadModel`. `sceneSrc` stays a path/URL —
 * it is resolved on the load path with every other model source.
 */
export interface WorldSceneResultWithPack extends WorldSceneResult {
  scene: Promise<Uint8Array>
}

/** Bit order the native action adapter expects: bit 0..7 = W,A,S,D,I,J,K,L. */
const KEY_ORDER: readonly WalkKey[] = ['W', 'A', 'S', 'D', 'I', 'J', 'K', 'L']

/**
 * Normalizes the three accepted key forms to the array the wire schema takes.
 *
 * A raw mask is accepted because the native session is ultimately driven by
 * one, and a key-state object is accepted because that is what a keyboard
 * handler naturally holds — neither should force the caller to convert.
 */
export function toWalkKeys(keys: WalkKeysInput | undefined): WalkKey[] {
  if (keys === undefined) return []

  if (typeof keys === 'number') {
    if (!Number.isInteger(keys) || keys < 0 || keys > 255) {
      throw new RequestValidationFailedError(
        `walk key mask must be an integer in [0, 255], got: ${keys}`
      )
    }
    return KEY_ORDER.filter((_, bit) => (keys & (1 << bit)) !== 0)
  }

  const pressed = Array.isArray(keys)
    ? keys.map((key) => String(key))
    : Object.entries(keys)
        .filter(([, held]) => Boolean(held))
        .map(([key]) => key)

  const seen = new Set<WalkKey>()
  for (const key of pressed) {
    const parsed = walkKeySchema.safeParse(key.toUpperCase())
    if (!parsed.success) {
      throw new RequestValidationFailedError(
        `unknown walk key '${key}' (valid: ${KEY_ORDER.join(', ')})`
      )
    }
    seen.add(parsed.data)
  }
  // Emit in bit order so an identical set of keys always produces an identical
  // request, whatever order the caller supplied them in.
  return KEY_ORDER.filter((key) => seen.has(key))
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  let settled = false
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      settled = true
      res(value)
    }
    reject = (error: Error) => {
      settled = true
      rej(error)
    }
  })
  // Nothing else settles these, so an unobserved rejection must not surface as
  // an unhandled rejection just because the caller only awaited one of them.
  promise.catch(() => {})
  return { promise, resolve, reject, isSettled: () => settled }
}

/**
 * A stream that ends without a `done` frame has to fail the result promises
 * explicitly. Nothing else settles them, so leaving them pending turns a
 * dropped connection or a truncated stream into an `await` that never returns —
 * a hang the caller cannot distinguish from slow generation, and cannot time
 * out because no error is ever delivered.
 *
 * `StreamEndedError` rather than a bare `Error`, matching `upscale.ts`, so a
 * caller can `instanceof` a dropped walk instead of matching on message text.
 */
function truncatedStream(): StreamEndedError {
  return new StreamEndedError()
}

/**
 * The world ops throw `InferenceCancelledError` on the server, so it crosses the
 * RPC envelope and arrives as a generic `RPCError` — `instanceof` fails and a
 * caller cannot tell a cancelled walk from a failed one. Rebuild it here rather
 * than registering a reconstructor in `client/rpc/rpc-error.ts`: that file's
 * maintenance contract keeps client-constructed typed errors out of the
 * reconstructor map, because a global entry would also fire for the completion
 * path, which builds this same class from its aggregated partial state.
 */
function asClientError(error: unknown, requestId: string): Error {
  if (error instanceof InferenceCancelledError) return error
  const code = (error as { code?: number } | null)?.code
  if (code === ERROR_CODES.INFERENCE_CANCELLED) {
    return new InferenceCancelledError(requestId, {}, error)
  }
  return error instanceof Error ? error : new Error(String(error))
}

export function createWorldStepResult(
  params: WorldStepClientParams,
  streamFactory: WorldStepStreamFactory
): WorldStepResult {
  const requestId = generateRequestId()
  const { keys, ...rest } = params
  // Validate before opening the stream so a bad key or a missing modelId fails
  // here rather than costing a server round-trip, as audio-gen-result.ts does.
  const request = parseClientInput(worldStepStreamRequestSchema, {
    ...rest,
    keys: toWalkKeys(keys),
    type: 'worldStepStream',
    requestId
  })

  const collected: Uint8Array[] = []
  const pending: Uint8Array[] = []
  // Its own queue and its own waker: a progress tick must not wake the frame
  // generator into an empty buffer, and a consumer may iterate either stream
  // alone.
  const progressPending: WorldStepProgressTick[] = []
  let done = false
  // Set by the terminal `done` frame; later chunks for the same request are
  // ignored rather than appended to a block that has already been delivered.
  let terminated = false
  let streamError: Error | null = null
  let wake: (() => void) | null = null
  let progressWake: (() => void) | null = null

  const framesOut = deferred<Uint8Array[]>()
  const statsOut = deferred<WorldStepStats | undefined>()

  async function pump() {
    try {
      for await (const response of streamFactory(request)) {
        if (
          response === null ||
          typeof response !== 'object' ||
          !('type' in response) ||
          response.type !== 'worldStepStream'
        ) {
          continue
        }
        const parsed = worldStepStreamResponseSchema.parse(response)

        // lunte-disable-next-line eqeqeq -- `!= null` intentionally matches null and undefined
        if (parsed.step != null && parsed.totalSteps != null && parsed.elapsedMs != null) {
          progressPending.push({
            step: parsed.step,
            totalSteps: parsed.totalSteps,
            elapsedMs: parsed.elapsedMs
          })
          progressWake?.()
          progressWake = null
        }

        // `done` is terminal for this block. Anything after it is not part of
        // the block the caller was handed, and accepting it would let
        // `frameStream` and the `frames` promise disagree about the same block:
        // `frames` is already resolved with what `collected` held at `done`,
        // while the generator would keep yielding.
        if (terminated) continue

        if (parsed.data) {
          const frame = decodeBase64(parsed.data)
          collected.push(frame)
          pending.push(frame)
          wake?.()
          wake = null
        }

        if (parsed.done) {
          terminated = true
          statsOut.resolve(parsed.stats)
          framesOut.resolve(collected)
        }
      }
    } catch (error) {
      streamError = asClientError(error, requestId)
      statsOut.reject(streamError)
      framesOut.reject(streamError)
    }

    if (!framesOut.isSettled()) {
      const truncated = streamError ?? truncatedStream()
      streamError = truncated
      statsOut.reject(truncated)
      framesOut.reject(truncated)
    }

    done = true
    wake?.()
    wake = null
    progressWake?.()
    progressWake = null
  }

  void pump()

  const progressStream = (async function* (): AsyncGenerator<WorldStepProgressTick> {
    while (true) {
      if (progressPending.length > 0) {
        yield progressPending.shift()!
      } else if (done) {
        if (streamError) throw streamError as Error
        return
      } else {
        await new Promise<void>((resolve) => {
          progressWake = resolve
        })
      }
    }
  })()

  const frameStream = (async function* (): AsyncGenerator<Uint8Array> {
    while (true) {
      if (pending.length > 0) {
        yield pending.shift()!
      } else if (done) {
        // The cast satisfies @typescript-eslint/only-throw-error, which does not
        // accept the `Error | null` declared type as throwable even though the
        // guard narrows it. Same shape as client/api/video.ts.
        if (streamError) throw streamError as Error
        return
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    }
  })()

  return {
    requestId,
    frameStream,
    progressStream,
    frames: framesOut.promise,
    stats: statsOut.promise
  }
}

// Three overloads, not two. Two was wrong for a params object typed
// `WorldSceneClientParams`: `returnPack` widens to `boolean | undefined` there,
// so a call passing `returnPack: true` through a variable failed the literal
// overload, fell to the broad one, and was typed as having no `scene` even
// though the runtime hands one back. The widened case now gets a union the
// caller has to narrow, which is honest about what is known at compile time.
export function createWorldSceneResult(
  params: WorldSceneClientParams & { returnPack: true },
  streamFactory: WorldSceneStreamFactory
): WorldSceneResultWithPack
export function createWorldSceneResult(
  params: WorldSceneClientParams & { returnPack?: false | undefined },
  streamFactory: WorldSceneStreamFactory
): WorldSceneResult
export function createWorldSceneResult(
  params: WorldSceneClientParams,
  streamFactory: WorldSceneStreamFactory
): WorldSceneResult | WorldSceneResultWithPack
export function createWorldSceneResult(
  params: WorldSceneClientParams,
  streamFactory: WorldSceneStreamFactory
): WorldSceneResult | WorldSceneResultWithPack {
  const requestId = generateRequestId()
  const { image, ...rest } = params

  // Checked on the RAW bytes, before base64. The schema has a `.max()` on the
  // encoded string, but it cannot be relied on to produce the error: Zod runs
  // every check on a string regardless of order, so the base64 pattern runs too,
  // and on V8 that pattern THROWS `RangeError: Maximum call stack size exceeded`
  // rather than returning false once the input passes roughly 4.5M characters.
  // `parseClientInput` only converts `ZodError`, so the caller would get a raw
  // RangeError instead of the typed validation error this API promises.
  if (image.byteLength > MAX_SCENE_IMAGE_BYTES) {
    throw new RequestValidationFailedError(
      `The first-frame image is ${image.byteLength} bytes, over the ` +
        `${MAX_SCENE_IMAGE_BYTES}-byte ceiling. It is cover-scaled and cropped to ` +
        'width x height, so send a smaller one.'
    )
  }

  // Empty prompts and dimensions that are not multiples of 32 are rejected
  // locally rather than after a round-trip carrying ~10 MB of image bytes.
  const request = parseClientInput(worldSceneStreamRequestSchema, {
    ...rest,
    image: encodeBase64(image),
    type: 'worldSceneStream',
    requestId
  })

  const wantsPack = params.returnPack === true
  const sceneOut = deferred<Uint8Array>()
  const statsOut = deferred<WorldSceneStats | undefined>()

  async function pump() {
    try {
      let scene: Uint8Array | undefined
      for await (const response of streamFactory(request)) {
        if (
          response === null ||
          typeof response !== 'object' ||
          !('type' in response) ||
          response.type !== 'worldSceneStream'
        ) {
          continue
        }
        const parsed = worldSceneStreamResponseSchema.parse(response)
        if (parsed.data) scene = decodeBase64(parsed.data)
        if (parsed.done) {
          statsOut.resolve(parsed.stats)
          if (scene) {
            sceneOut.resolve(scene)
          } else if (wantsPack) {
            // Only a failure when the caller asked for the bytes; otherwise the
            // server keeping them is the whole point of the default.
            // Same typed error the other stream helpers raise for a response
            // that is well-formed but missing what it promised.
            sceneOut.reject(new InvalidResponseError('worldSceneStream scene pack'))
          }
        }
      }
    } catch (error) {
      const failure = asClientError(error, requestId)
      statsOut.reject(failure)
      sceneOut.reject(failure)
    }

    if (!statsOut.isSettled()) {
      const failure = truncatedStream()
      statsOut.reject(failure)
      sceneOut.reject(failure)
    }
  }

  void pump()

  // `scene` is present only on the requested shape, so a caller who did not ask
  // for the bytes has nothing to await by mistake.
  return wantsPack
    ? { requestId, scene: sceneOut.promise, stats: statsOut.promise }
    : { requestId, stats: statsOut.promise }
}
