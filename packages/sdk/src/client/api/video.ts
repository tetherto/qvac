import {
  videoStreamResponseSchema,
  type VideoClientParams,
  type VideoStats
} from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { createVideoStreamRequest } from '@/client/api/video-request'
import { decodeBase64 } from '@/utils/encoding'

export interface VideoProgressTick {
  step: number
  totalSteps: number
  elapsedMs: number
}

export interface VideoResult {
  requestId: string
  progressStream: AsyncGenerator<VideoProgressTick>
  outputs: Promise<Uint8Array[]>
  stats: Promise<VideoStats | undefined>
}

/**
 * Generates a video using a loaded video diffusion model.
 *
 * @param params - Video request parameters (model, prompt, dimensions, frame count, fps, sampler, seed, etc.).
 * @returns A result object exposing `requestId` (stable identifier for this in-flight generation), `progressStream` (async iterator of `{ step, totalSteps, elapsedMs }`), `outputs` (promise of the generated video buffers, typically a single AVI file), and `stats` (promise of generation statistics).
 *
 * Supports `txt2vid` (text-to-video) and `img2vid` (image-to-video) for both the
 * Wan and LTX-2 layouts. For Wan `img2vid`, load the pipeline with
 * `modelConfig.clipVisionModelSrc` set to `clip_vision_h.safetensors`; LTX-2
 * `img2vid` conditions on the first frame through its video VAE and needs no
 * CLIP vision weights (the same LTX-2 model loaded for txt2vid also does
 * img2vid). On React Native, the bundled video diffusion models are too large
 * for typical mobile devices.
 *
 * @example Basic txt2vid generation
 * ```typescript
 * const { outputs, stats } = video({
 *   modelId,
 *   mode: "txt2vid",
 *   prompt: "a cat surfing a wave at sunset",
 *   width: 480,
 *   height: 832,
 *   video_frames: 17, // must satisfy (4*k + 1)
 *   fps: 16,
 * });
 * const buffers = await outputs;
 * fs.writeFileSync("output.avi", buffers[0]);
 * ```
 *
 * @example With progress tracking
 * ```typescript
 * const { progressStream, outputs } = video({
 *   modelId,
 *   mode: "txt2vid",
 *   prompt: "a sunset over the ocean",
 * });
 * for await (const { step, totalSteps } of progressStream) {
 *   console.log(`${step}/${totalSteps}`);
 * }
 * const buffers = await outputs;
 * ```
 *
 * @example Image-to-video (first frame + motion prompt)
 * ```typescript
 * const firstFrame = fs.readFileSync("portrait.png");
 * const { outputs } = video({
 *   modelId,
 *   mode: "img2vid",
 *   prompt: "the subject slowly turns and smiles, cinematic lighting",
 *   init_image: firstFrame,
 *   strength: 0.85,
 * });
 * ```
 *
 * @example With control frames (e.g. for guided generation)
 * ```typescript
 * const frameA = fs.readFileSync("frame-a.png");
 * const frameB = fs.readFileSync("frame-b.png");
 * const { outputs } = video({
 *   modelId,
 *   mode: "txt2vid",
 *   prompt: "smooth transition between scenes",
 *   control_frames: [frameA, frameB],
 * });
 * ```
 *
 * @example LTX Ingredients reference conditioning
 * ```typescript
 * const referenceSheet = fs.readFileSync("reference-sheet.png");
 * const { outputs } = video({
 *   modelId,
 *   mode: "txt2vid",
 *   prompt: "Reference sheet: a red-haired explorer. Generated video: the explorer crosses a snowy ridge.",
 *   lora: "/absolute/path/to/ltx-2-ingredients.safetensors",
 *   lora_strength: 1.37,
 *   stg_scale: 1,
 *   stg_block: 29,
 *   reference_images: [referenceSheet],
 *   reference_attention_strength: 1,
 *   reference_downscale_factor: 1,
 *   video_frames: 217,
 *   scheduler: "ltx2",
 * });
 * const buffers = await outputs;
 * ```
 *
 * @example Cancellation via requestId
 * ```typescript
 * const { requestId, outputs } = video({ modelId, mode: "txt2vid", prompt: "..." });
 * // ...later
 * await cancel(requestId);
 * ```
 */
export function video(params: VideoClientParams): VideoResult {
  const requestId = generateClientRequestId()
  const request = createVideoStreamRequest(params, requestId)

  let statsResolver: (value: VideoStats | undefined) => void = () => {}
  let statsRejecter: (error: unknown) => void = () => {}
  const statsPromise = new Promise<VideoStats | undefined>((resolve, reject) => {
    statsResolver = resolve
    statsRejecter = reject
  })
  statsPromise.catch(() => {})

  const progressQueue: VideoProgressTick[] = []
  const collectedBuffers: Uint8Array[] = []
  let progressDone = false
  let progressResolve: (() => void) | null = null
  let streamError: Error | null = null

  let outputsResolver: (value: Uint8Array[]) => void = () => {}
  let outputsRejecter: (error: unknown) => void = () => {}
  const outputsPromise = new Promise<Uint8Array[]>((resolve, reject) => {
    outputsResolver = resolve
    outputsRejecter = reject
  })
  outputsPromise.catch(() => {})

  async function processResponses() {
    try {
      for await (const response of streamRpc(request)) {
        if (
          response &&
          typeof response === 'object' &&
          'type' in response &&
          response.type === 'videoStream'
        ) {
          const parsed = videoStreamResponseSchema.parse(response)

          if (
            parsed.step !== undefined &&
            parsed.totalSteps !== undefined &&
            parsed.elapsedMs !== undefined
          ) {
            progressQueue.push({
              step: parsed.step,
              totalSteps: parsed.totalSteps,
              elapsedMs: parsed.elapsedMs
            })
            if (progressResolve) {
              progressResolve()
              progressResolve = null
            }
          }

          if (parsed.data) {
            collectedBuffers.push(decodeBase64(parsed.data))
          }

          if (parsed.done) {
            statsResolver(parsed.stats)
            outputsResolver(collectedBuffers)
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error))
      statsRejecter(streamError)
      outputsRejecter(streamError)
    }

    progressDone = true
    if (progressResolve) {
      progressResolve()
      progressResolve = null
    }
  }

  void processResponses()

  const progressStream = (async function* (): AsyncGenerator<VideoProgressTick> {
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
    outputs: outputsPromise,
    stats: statsPromise
  }
}
