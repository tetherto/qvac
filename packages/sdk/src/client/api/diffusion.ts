import {
  diffusionStreamResponseSchema,
  renameLegacyDiffusionParams,
  type DiffusionStreamRequest,
  type LegacyDiffusionClientParams,
  type DiffusionStats,
  type RPCOptions
} from '@qvac/inference/surface'
import { warnLegacyKey } from '@/utils/legacy-keys'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { decodeBase64, encodeBase64 } from '@/utils/encoding'

export interface DiffusionProgressTick {
  step: number
  totalSteps: number
  elapsedMs: number
}

interface DiffusionResult {
  /** Stable id of this generation; pass to `cancel({ requestId })` to stop it. */
  requestId: string
  progressStream: AsyncGenerator<DiffusionProgressTick>
  outputs: Promise<Uint8Array[]>
  stats: Promise<DiffusionStats | undefined>
}

/**
 * Generates images using a loaded diffusion model.
 *
 * @param params - Diffusion request parameters (model, prompt, dimensions, sampler, seed, etc.).
 * @param options - Optional RPC options (timeout, profiling, force new connection).
 * @returns A result object exposing `requestId` (stable identifier for this generation, for `cancel({ requestId })`), `progressStream` (async iterator of `{ step, totalSteps, elapsedMs }`), `outputs` (promise of the generated image buffers), and `stats` (promise of generation statistics).
 * @throws {InferenceCancelledError} The run's promises reject and progress stream throws when an active generation is cancelled.
 * @throws {RequestRejectedByPolicyError} The run rejects when another image or video generation owns the model.
 *
 * Supports txt2img without input images, img2img via `initImage`,
 * and ordered multi-reference editing via `initImages` on supported models.
 *
 * @example
 * ```typescript
 * // txt2img
 * const { outputs, stats } = diffusion({ modelId, prompt: "a cat" });
 * const buffers = await outputs;
 * fs.writeFileSync("output.png", buffers[0]);
 *
 * // img2img (SD/SDXL — SDEdit)
 * const initImage = fs.readFileSync("input.png");
 * const { outputs } = diffusion({ modelId, prompt: "oil painting style", initImage: initImage, strength: 0.7 });
 *
 * // img2img (FLUX.2 — in-context conditioning)
 * // IMPORTANT: FLUX.2 img2img requires `prediction: "flux2_flow"` to be set on the
 * // model config at loadModel time (e.g. `loadModel(src, { modelType: "diffusion",
 * // modelConfig: { prediction: "flux2_flow" } })`).
 * const { outputs } = diffusion({ modelId, prompt: "turn into watercolor", initImage: initImage });
 *
 * // FLUX.2 multi-reference fusion
 * // IMPORTANT: requires the model loaded with `modelConfig: { prediction: "flux2_flow" }`
 * // and a Qwen3 text encoder via `llmModelSrc` (same loadModel requirements as the
 * // FLUX.2 img2img example above). `initImage` and `initImages` are mutually
 * // exclusive — pass one or the other, not both.
 * const refA = fs.readFileSync("scientist-a.jpg");
 * const refB = fs.readFileSync("scientist-b.jpg");
 * const { outputs } = diffusion({
 *   modelId,
 *   prompt: "a portrait using most visual traits from @image1 and the eyes from @image2",
 *   initImages: [refA, refB],
 *   width: 768,
 *   height: 768,
 * });
 *
 * // FLUX.3 Image Klein reference editing. Load the Qwen3-VL 4B encoder and the
 * // FLUX.2 VAE; the engine detects FLUX.3 from the weights, so leave `prediction` unset.
 * const { outputs: flux3Edit } = diffusion({
 *   modelId,
 *   prompt: "Place the subject in a lush garden, preserving its appearance.",
 *   initImages: [refA],
 *   width: 512,
 *   height: 512,
 *   steps: 16,
 *   cfgScale: 1,
 *   samplingMethod: "euler",
 * });
 *
 * // Qwen-Image-2.1 reference editing. Load the matching Qwen3-VL encoder,
 * // vision projector, and 2.1 VAE from your local files first.
 * const { outputs: edited } = diffusion({
 *   modelId,
 *   prompt: "Place the two referenced people together in one office.",
 *   initImages: [refA, refB],
 *   width: 512,
 *   height: 512,
 *   steps: 30,
 *   cfgScale: 6,
 *   samplingMethod: "euler",
 *   seed: 42,
 * });
 *
 * // LoRA adapter for this generation (absolute path required).
 * // Persistence across subsequent diffusion() calls is controlled at
 * // loadModel time via `modelConfig.loraApplyMode`.
 * const { outputs } = diffusion({
 *   modelId,
 *   prompt: "a watercolor cat",
 *   lora: "/home/user/loras/watercolor.safetensors",
 * });
 *
 * // ESRGAN upscale; requires the model to be loaded with `modelConfig.upscaler.modelSrc` set.
 * const { outputs: singleOutputs } = diffusion({
 *   modelId,
 *   prompt: "a fox portrait",
 *   width: 128,
 *   height: 128,
 *   upscale: true, // one native-scale pass
 * });
 * const single = await singleOutputs;
 * fs.writeFileSync("upscaled.png", single[0]);
 *
 * // Repeat upscale passes when needed.
 * const { outputs: hiresOutputs } = diffusion({
 *   modelId,
 *   prompt: "a fox portrait",
 *   width: 128,
 *   height: 128,
 *   upscale: { repeats: 2 },
 * });
 * const hires = await hiresOutputs;
 * fs.writeFileSync("hires.png", hires[0]);
 *
 * // With progress tracking
 * const { progressStream, outputs } = diffusion({ modelId, prompt: "a cat" });
 * for await (const { step, totalSteps } of progressStream) {
 *   console.log(`${step}/${totalSteps}`);
 * }
 * const buffers = await outputs;
 * ```
 */
export function diffusion(
  params: LegacyDiffusionClientParams,
  options?: RPCOptions
): DiffusionResult {
  const { initImage, initImages, ...rest } = renameLegacyDiffusionParams(params, warnLegacyKey)

  const requestId = generateClientRequestId()
  const request: DiffusionStreamRequest = {
    ...rest,
    ...(initImage !== undefined && { initImage: encodeBase64(initImage) }),
    ...(initImages !== undefined && {
      initImages: initImages.map(encodeBase64)
    }),
    type: 'diffusionStream',
    requestId
  }

  let statsResolver: (value: DiffusionStats | undefined) => void = () => {}
  let statsRejecter: (error: unknown) => void = () => {}
  const statsPromise = new Promise<DiffusionStats | undefined>((resolve, reject) => {
    statsResolver = resolve
    statsRejecter = reject
  })
  statsPromise.catch(() => {})

  const progressQueue: DiffusionProgressTick[] = []
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

  const processResponses = async () => {
    try {
      for await (const response of streamRpc(request, options)) {
        if (
          response &&
          typeof response === 'object' &&
          'type' in response &&
          response.type === 'diffusionStream'
        ) {
          const parsed = diffusionStreamResponseSchema.parse(response)

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

  const progressStream = (async function* (): AsyncGenerator<DiffusionProgressTick> {
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
