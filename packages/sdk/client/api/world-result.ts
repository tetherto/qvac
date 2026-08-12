import {
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
import { parseClientInput } from '@/client/parse-input'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { decodeBase64, encodeBase64 } from '@/utils/encoding'
import { RequestValidationFailedError } from '@/utils/errors-client'

export type WorldStepStreamFactory = (request: WorldStepStreamRequest) => AsyncGenerator<unknown>

export type WorldSceneStreamFactory = (request: WorldSceneStreamRequest) => AsyncGenerator<unknown>

export interface WorldStepResult {
  requestId: string
  /** Frames of this block, yielded as they arrive rather than at the end. */
  frameStream: AsyncGenerator<Uint8Array>
  /** Every frame of the block, once it completes. */
  frames: Promise<Uint8Array[]>
  stats: Promise<WorldStepStats | undefined>
}

export interface WorldSceneResult {
  requestId: string
  /** The finished scene pack; pass it back as `modelConfig.sceneSrc` to revisit this world. */
  scene: Promise<Uint8Array>
  stats: Promise<WorldSceneStats | undefined>
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
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Nothing else settles these, so an unobserved rejection must not surface as
  // an unhandled rejection just because the caller only awaited one of them.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

export function createWorldStepResult(
  params: WorldStepClientParams,
  streamFactory: WorldStepStreamFactory
): WorldStepResult {
  const requestId = generateClientRequestId()
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
  let done = false
  let streamError: Error | null = null
  let wake: (() => void) | null = null

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

        if (parsed.data) {
          const frame = decodeBase64(parsed.data)
          collected.push(frame)
          pending.push(frame)
          wake?.()
          wake = null
        }

        if (parsed.done) {
          statsOut.resolve(parsed.stats)
          framesOut.resolve(collected)
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error))
      statsOut.reject(streamError)
      framesOut.reject(streamError)
    }

    done = true
    wake?.()
    wake = null
  }

  void pump()

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

  return { requestId, frameStream, frames: framesOut.promise, stats: statsOut.promise }
}

export function createWorldSceneResult(
  params: WorldSceneClientParams,
  streamFactory: WorldSceneStreamFactory
): WorldSceneResult {
  const requestId = generateClientRequestId()
  const { image, ...rest } = params
  // Empty prompts and dimensions that are not multiples of 32 are rejected
  // locally rather than after a round-trip carrying ~10 MB of image bytes.
  const request = parseClientInput(worldSceneStreamRequestSchema, {
    ...rest,
    image: encodeBase64(image),
    type: 'worldSceneStream',
    requestId
  })

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
          } else {
            sceneOut.reject(new Error('World scene creation finished without returning a pack'))
          }
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      statsOut.reject(failure)
      sceneOut.reject(failure)
    }
  }

  void pump()

  return { requestId, scene: sceneOut.promise, stats: statsOut.promise }
}
