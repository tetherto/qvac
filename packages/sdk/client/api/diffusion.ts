import {
  diffusionStreamResponseSchema,
  type DiffusionStreamRequest,
  type DiffusionClientParams,
  type DiffusionStats,
} from "@/schemas";
import { stream as streamRpc } from "@/client/rpc/rpc-client";
import { decodeBase64, encodeBase64 } from "@/utils/encoding";

export interface DiffusionProgressTick {
  step: number;
  totalSteps: number;
  elapsedMs: number;
}

interface DiffusionResult {
  progressStream: AsyncGenerator<DiffusionProgressTick>;
  outputs: Promise<Uint8Array[]>;
  stats: Promise<DiffusionStats | undefined>;
}

/**
 * Generates images using a loaded diffusion model.
 *
 * @param params - Diffusion request parameters (model, prompt, dimensions, sampler, seed, etc.).
 * @returns A result object exposing `progressStream` (async iterator of `{ step, totalSteps, elapsedMs }`), `outputs` (promise of the generated image buffers), and `stats` (promise of generation statistics).
 *
 * Supports both txt2img (no `init_image`) and img2img (with `init_image`).
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
 * const { outputs } = diffusion({ modelId, prompt: "oil painting style", init_image: initImage, strength: 0.7 });
 *
 * // img2img (FLUX.2 — in-context conditioning)
 * // IMPORTANT: FLUX img2img requires `prediction: "flux2_flow"` to be set on the
 * // model config at loadModel time (e.g. `loadModel(src, { modelType: "diffusion",
 * // modelConfig: { prediction: "flux2_flow" } })`).
 * const { outputs } = diffusion({ modelId, prompt: "turn into watercolor", init_image: initImage });
 *
 * // FLUX.2 multi-reference fusion
 * // IMPORTANT: requires the model loaded with `modelConfig: { prediction: "flux2_flow" }`
 * // and a Qwen3 text encoder via `llmModelSrc` (same loadModel requirements as the
 * // FLUX.2 img2img example above). `init_image` and `init_images` are mutually
 * // exclusive — pass one or the other, not both.
 * const refA = fs.readFileSync("scientist-a.jpg");
 * const refB = fs.readFileSync("scientist-b.jpg");
 * const { outputs } = diffusion({
 *   modelId,
 *   prompt: "a portrait using most visual traits from @image1 and the eyes from @image2",
 *   init_images: [refA, refB],
 *   width: 768,
 *   height: 768,
 * });
 *
 * // LoRA adapter for this generation (absolute path required).
 * // Persistence across subsequent diffusion() calls is controlled at
 * // loadModel time via `modelConfig.lora_apply_mode`.
 * const { outputs } = diffusion({
 *   modelId,
 *   prompt: "a watercolor cat",
 *   lora: "/home/user/loras/watercolor.safetensors",
 * });
 *
 * // With progress tracking
 * const { progressStream, outputs } = diffusion({ modelId, prompt: "a cat" });
 * for await (const { step, totalSteps } of progressStream) {
 *   console.log(`${step}/${totalSteps}`);
 * }
 * const buffers = await outputs;
 * ```
 */
export function diffusion(params: DiffusionClientParams): DiffusionResult {
  const { init_image, init_images, ...rest } = params;

  const request: DiffusionStreamRequest = {
    ...rest,
    ...(init_image !== undefined && { init_image: encodeBase64(init_image) }),
    ...(init_images !== undefined && {
      init_images: init_images.map(encodeBase64),
    }),
    type: "diffusionStream",
  };

  let statsResolver: (value: DiffusionStats | undefined) => void = () => {};
  let statsRejecter: (error: unknown) => void = () => {};
  const statsPromise = new Promise<DiffusionStats | undefined>(
    (resolve, reject) => {
      statsResolver = resolve;
      statsRejecter = reject;
    },
  );
  statsPromise.catch(() => {});

  const progressQueue: DiffusionProgressTick[] = [];
  const collectedBuffers: Uint8Array[] = [];
  let progressDone = false;
  let progressResolve: (() => void) | null = null;
  let streamError: Error | null = null;

  let outputsResolver: (value: Uint8Array[]) => void = () => {};
  let outputsRejecter: (error: unknown) => void = () => {};
  const outputsPromise = new Promise<Uint8Array[]>((resolve, reject) => {
    outputsResolver = resolve;
    outputsRejecter = reject;
  });
  outputsPromise.catch(() => {});

  const processResponses = async () => {
    try {
      for await (const response of streamRpc(request)) {
        if (
          response &&
          typeof response === "object" &&
          "type" in response &&
          response.type === "diffusionStream"
        ) {
          const parsed = diffusionStreamResponseSchema.parse(response);

          if (parsed.step != null && parsed.totalSteps != null && parsed.elapsedMs != null) {
            progressQueue.push({ step: parsed.step, totalSteps: parsed.totalSteps, elapsedMs: parsed.elapsedMs });
            if (progressResolve) {
              progressResolve();
              progressResolve = null;
            }
          }

          if (parsed.data) {
            collectedBuffers.push(decodeBase64(parsed.data));
          }

          if (parsed.done) {
            statsResolver(parsed.stats);
            outputsResolver(collectedBuffers);
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
      statsRejecter(streamError);
      outputsRejecter(streamError);
    }

    progressDone = true;
    if (progressResolve) {
      progressResolve();
      progressResolve = null;
    }
  };

  void processResponses();

  const progressStream = (async function* (): AsyncGenerator<DiffusionProgressTick> {
    while (true) {
      if (progressQueue.length > 0) {
        yield progressQueue.shift()!;
      } else if (progressDone) {
        if (streamError) throw streamError as Error;
        return;
      } else {
        await new Promise<void>((resolve) => { progressResolve = resolve; });
      }
    }
  })();

  return {
    progressStream,
    outputs: outputsPromise,
    stats: statsPromise,
  };
}
