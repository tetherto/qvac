import {
  generationStreamResponseSchema,
  type GenerationStreamRequest,
  type GenerationClientParams,
  type DiffusionStats,
} from "@/schemas";
import { stream as streamRpc } from "@/client/rpc/rpc-client";

interface GenerationResult {
  outputStream: AsyncGenerator<{ data: string; outputIndex: number }>;
  outputs: Promise<Buffer[]>;
  stats: Promise<DiffusionStats | undefined>;
}

/**
 * Generate outputs using a loaded diffusion model.
 *
 * Supports text-to-image, image-to-image, and (future) video generation.
 * img2img is activated by providing `init_image` (and optionally `strength`).
 *
 * @param params - Generation parameters
 * @param params.modelId - The identifier of the loaded diffusion model
 * @param params.prompt - Text prompt describing the desired output
 * @param params.init_image - Source image for img2img (base64 string or Buffer). Omit for txt2img.
 * @param params.strength - How much to transform the source: 0 = keep, 1 = ignore. Only used with init_image.
 * @param params.stream - Whether to stream outputs as they arrive (true) or return all at once (false). Defaults to false.
 * @returns Object with outputStream generator, outputs promise, and stats promise
 * @example
 * ```typescript
 * // txt2img (non-streaming)
 * const { outputs, stats } = generation({ modelId, prompt: "a cat" });
 * const buffers = await outputs;
 *
 * // txt2img (streaming)
 * const { outputStream } = generation({ modelId, prompt: "a cat", stream: true });
 * for await (const { data, outputIndex } of outputStream) {
 *   fs.writeFileSync(`output_${outputIndex}.png`, Buffer.from(data, "base64"));
 * }
 *
 * // img2img
 * const { outputs } = generation({
 *   modelId,
 *   prompt: "watercolor style",
 *   init_image: fs.readFileSync("photo.png"),
 *   strength: 0.75,
 * });
 * ```
 */
export function generation(params: GenerationClientParams): GenerationResult {
  const { stream: streaming, init_image, ...rest } = params;

  const request: GenerationStreamRequest = {
    type: "generationStream",
    ...rest,
    ...(init_image != null && {
      init_image:
        typeof init_image === "string"
          ? init_image
          : init_image.toString("base64"),
    }),
  };

  let diffusionStats: DiffusionStats | undefined;
  let statsResolver: (value: DiffusionStats | undefined) => void = () => {};
  const statsPromise = new Promise<DiffusionStats | undefined>((resolve) => {
    statsResolver = resolve;
  });

  if (streaming) {
    const outputStream = (async function* () {
      for await (const response of streamRpc(request)) {
        if (response.type === "generationStream") {
          const parsed = generationStreamResponseSchema.parse(response);
          if (parsed.data) {
            yield { data: parsed.data, outputIndex: parsed.outputIndex ?? 0 };
          }
          if (parsed.done) {
            diffusionStats = parsed.stats;
            statsResolver(diffusionStats);
          }
        }
      }
    })();

    return {
      outputStream,
      outputs: Promise.resolve([]),
      stats: statsPromise,
    };
  }

  const outputStream = (async function* () {
    // Empty generator for non-streaming mode
  })();

  const outputsPromise = (async () => {
    const collected: Buffer[] = [];
    for await (const response of streamRpc(request)) {
      if (response.type === "generationStream") {
        const parsed = generationStreamResponseSchema.parse(response);
        if (parsed.data) {
          collected.push(Buffer.from(parsed.data, "base64"));
        }
        if (parsed.done) {
          diffusionStats = parsed.stats;
          statsResolver(diffusionStats);
        }
      }
    }
    return collected;
  })();

  return {
    outputStream,
    outputs: outputsPromise,
    stats: statsPromise,
  };
}
