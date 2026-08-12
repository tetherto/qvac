import {
  worldStepStreamResponseSchema,
  worldSceneStreamResponseSchema,
  type WorldStepStreamRequest,
  type WorldStepClientParams,
  type WorldSceneStreamRequest,
  type WorldSceneClientParams,
  type WorldStats,
  type WorldSceneStats
} from '@/schemas'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { decodeBase64, encodeBase64 } from '@/utils/encoding'

export interface WorldProgressTick {
  step: number
  frames: number
  elapsedMs: number
}

export interface WorldStepResult {
  requestId: string
  progressStream: AsyncGenerator<WorldProgressTick>
  frames: Promise<Uint8Array[]>
  stats: Promise<WorldStats | undefined>
}

export interface WorldSceneResult {
  requestId: string
  stats: Promise<WorldSceneStats | undefined>
}

/**
 * Generates the next block of an ABot-World interactive walk.
 *
 * @param params - Step parameters: `modelId` of a model loaded with `modelConfig.mode: 'world'`, and the `keys` held during this block (array of `'W'|'A'|'S'|'D'|'I'|'J'|'K'|'L'` or a raw 8-bit action mask; omit for an idle block).
 * @returns A result object exposing `requestId` (usable with `cancel()`), `progressStream` (async iterator of `{ step, frames, elapsedMs }` — one tick per block), `frames` (promise of the decoded RGB frames of this block, PNG or JPEG depending on `modelConfig.world.frame_jpeg_quality`), and `stats` (promise of cumulative session statistics).
 *
 * ABot-World is a causal world model: each step denoises one block under the
 * held keys and streams its frames, so a walk is a loop of `worldStep` calls
 * driven by user input. Steps are serialized per session — await the previous
 * step's `frames` before issuing the next. A cancelled or failed step is
 * terminal for the session: unload and reload the model to walk again.
 *
 * @example Interactive walk loop
 * ```typescript
 * for (const keys of [["W"], ["W"], ["W", "L"], []] as const) {
 *   const { frames } = worldStep({ modelId, keys: [...keys] });
 *   for (const frame of await frames) render(frame);
 * }
 * ```
 *
 * @example Raw action mask (ActionFlag bit values of the addon)
 * ```typescript
 * const { frames } = worldStep({ modelId, keys: 0b10000001 }); // W + L held
 * ```
 */
export function worldStep(params: WorldStepClientParams): WorldStepResult {
  const requestId = generateClientRequestId()

  const request: WorldStepStreamRequest = {
    ...params,
    type: 'worldStep',
    requestId
  }

  let statsResolver: (value: WorldStats | undefined) => void = () => {}
  let statsRejecter: (error: unknown) => void = () => {}
  const statsPromise = new Promise<WorldStats | undefined>((resolve, reject) => {
    statsResolver = resolve
    statsRejecter = reject
  })
  statsPromise.catch(() => {})

  const progressQueue: WorldProgressTick[] = []
  const collectedFrames: Uint8Array[] = []
  let progressDone = false
  let progressResolve: (() => void) | null = null
  let streamError: Error | null = null

  let framesResolver: (value: Uint8Array[]) => void = () => {}
  let framesRejecter: (error: unknown) => void = () => {}
  const framesPromise = new Promise<Uint8Array[]>((resolve, reject) => {
    framesResolver = resolve
    framesRejecter = reject
  })
  framesPromise.catch(() => {})

  async function processResponses() {
    try {
      for await (const response of streamRpc(request)) {
        if (
          response &&
          typeof response === 'object' &&
          'type' in response &&
          response.type === 'worldStep'
        ) {
          const parsed = worldStepStreamResponseSchema.parse(response)

          if (parsed.step != null && parsed.frames != null && parsed.elapsedMs != null) {
            progressQueue.push({
              step: parsed.step,
              frames: parsed.frames,
              elapsedMs: parsed.elapsedMs
            })
            if (progressResolve) {
              progressResolve()
              progressResolve = null
            }
          }

          if (parsed.data) {
            collectedFrames.push(decodeBase64(parsed.data))
          }

          if (parsed.done) {
            statsResolver(parsed.stats)
            framesResolver(collectedFrames)
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error))
      statsRejecter(streamError)
      framesRejecter(streamError)
    }

    progressDone = true
    if (progressResolve) {
      progressResolve()
      progressResolve = null
    }
  }

  void processResponses()

  const progressStream = (async function* (): AsyncGenerator<WorldProgressTick> {
    while (true) {
      if (progressQueue.length > 0) {
        yield progressQueue.shift()!
      } else if (progressDone) {
        if (streamError) throw streamError as Error
        return
      } else {
        await new Promise<void>((resolve) => {
          progressResolve = resolve
        })
      }
    }
  })()

  return {
    requestId,
    progressStream,
    frames: framesPromise,
    stats: statsPromise
  }
}

/**
 * Creates an ABot-World scene pack natively: umT5-XXL encodes the prompt and
 * the Wan 2.2 VAE encodes the first-frame image; the pack is written to the
 * `modelConfig.world.scenePack` path the model was loaded with (output paths
 * are never accepted per request). The walk session loads it on the next
 * `worldStep` — including when the pack did not exist at `loadModel` time.
 *
 * @param params - Scene parameters: `modelId` of a model loaded with `modelConfig.mode: 'world'` plus `t5XxlModelSrc` and `vaeModelSrc`; `prompt` (scene description); `image` (first-frame PNG/JPEG bytes, any size — cover-scaled and center-cropped); optional `width`/`height` (multiples of 32; default 832x480, the model's native resolution).
 * @returns A result object exposing `requestId` and `stats` (promise resolving on completion with `{ sceneCreateMs, width, height }`).
 *
 * @example Create a world from a photo, then walk it
 * ```typescript
 * const photo = fs.readFileSync("first-frame.jpg");
 * const { stats } = worldCreateScene({
 *   modelId,
 *   prompt: "a realistic outdoor scene with a navigable path",
 *   image: photo,
 * });
 * await stats; // scene pack written
 * const { frames } = worldStep({ modelId, keys: ["W"] });
 * ```
 */
export function worldCreateScene(params: WorldSceneClientParams): WorldSceneResult {
  const requestId = generateClientRequestId()

  const { image, ...rest } = params
  const request: WorldSceneStreamRequest = {
    ...rest,
    image: encodeBase64(image),
    type: 'worldCreateScene',
    requestId
  }

  let statsResolver: (value: WorldSceneStats | undefined) => void = () => {}
  let statsRejecter: (error: unknown) => void = () => {}
  const statsPromise = new Promise<WorldSceneStats | undefined>((resolve, reject) => {
    statsResolver = resolve
    statsRejecter = reject
  })
  statsPromise.catch(() => {})

  async function processResponses() {
    try {
      for await (const response of streamRpc(request)) {
        if (
          response &&
          typeof response === 'object' &&
          'type' in response &&
          response.type === 'worldCreateScene'
        ) {
          const parsed = worldSceneStreamResponseSchema.parse(response)
          if (parsed.done) {
            statsResolver(parsed.stats)
          }
        }
      }
    } catch (error) {
      statsRejecter(error instanceof Error ? error : new Error(String(error)))
    }
  }

  void processResponses()

  return {
    requestId,
    stats: statsPromise
  }
}
