import {
  generationStreamResponseSchema,
  type GenerationStreamRequest,
  type GenerationClientParams,
  type DiffusionStats,
} from "@/schemas";
import { stream as streamRpc } from "@/client/rpc/rpc-client";

export interface GenerationProgressTick {
  step: number;
  totalSteps: number;
  elapsedMs: number;
}

interface GenerationResult {
  outputStream: AsyncGenerator<{ data: string; outputIndex: number }>;
  progressStream: AsyncGenerator<GenerationProgressTick>;
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
 * @returns Object with outputStream generator, progressStream generator, outputs promise, and stats promise
 * @example
 * ```typescript
 * // txt2img (non-streaming)
 * const { outputs, stats } = generation({ modelId, prompt: "a cat" });
 * const buffers = await outputs;
 *
 * // txt2img (streaming with progress)
 * const { outputStream, progressStream } = generation({ modelId, prompt: "a cat", stream: true });
 * // consume progress in parallel
 * (async () => { for await (const { step, totalSteps } of progressStream) console.log(`${step}/${totalSteps}`); })();
 * for await (const { data, outputIndex } of outputStream) {
 *   fs.writeFileSync(`output_${outputIndex}.png`, Buffer.from(data, "base64"));
 * }
 *
 * // img2img
 * const { outputs } = generation({
 *   modelId,
 *   prompt: "watercolor style",
 *   init_image: fs.readFileSync("photo.jpg"),
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

  let statsResolver: (value: DiffusionStats | undefined) => void = () => {};
  let statsRejecter: (error: unknown) => void = () => {};
  const statsPromise = new Promise<DiffusionStats | undefined>(
    (resolve, reject) => {
      statsResolver = resolve;
      statsRejecter = reject;
    },
  );
  statsPromise.catch(() => {});

  const outputQueue: { data: string; outputIndex: number }[] = [];
  const progressQueue: GenerationProgressTick[] = [];
  const collectedBuffers: Buffer[] = [];
  let outputDone = false;
  let progressDone = false;
  let outputResolve: (() => void) | null = null;
  let progressResolve: (() => void) | null = null;
  let streamError: Error | null = null;

  let outputsResolver: (value: Buffer[]) => void = () => {};
  let outputsRejecter: (error: unknown) => void = () => {};
  const outputsPromise = new Promise<Buffer[]>((resolve, reject) => {
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
          response.type === "generationStream"
        ) {
          const parsed = generationStreamResponseSchema.parse(response);

          if (parsed.step != null && parsed.totalSteps != null && parsed.elapsedMs != null) {
            progressQueue.push({ step: parsed.step, totalSteps: parsed.totalSteps, elapsedMs: parsed.elapsedMs });
            if (progressResolve) {
              progressResolve();
              progressResolve = null;
            }
          }

          if (parsed.data) {
            const outputEntry = { data: parsed.data, outputIndex: parsed.outputIndex ?? 0 };
            outputQueue.push(outputEntry);
            collectedBuffers.push(Buffer.from(parsed.data, "base64"));
            if (outputResolve) {
              outputResolve();
              outputResolve = null;
            }
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

    outputDone = true;
    progressDone = true;
    if (outputResolve) {
      outputResolve();
      outputResolve = null;
    }
    if (progressResolve) {
      progressResolve();
      progressResolve = null;
    }
  };

  void processResponses();

  const progressStream = (async function* (): AsyncGenerator<GenerationProgressTick> {
    while (true) {
      if (progressQueue.length > 0) {
        yield progressQueue.shift()!;
      } else if (progressDone) {
        if (streamError) throw streamError;
        return;
      } else {
        await new Promise<void>((resolve) => { progressResolve = resolve; });
      }
    }
  })();

  if (streaming) {
    const outputStream = (async function* () {
      while (true) {
        if (outputQueue.length > 0) {
          yield outputQueue.shift()!;
        } else if (outputDone) {
          if (streamError) throw streamError;
          return;
        } else {
          await new Promise<void>((resolve) => { outputResolve = resolve; });
        }
      }
    })();

    return {
      outputStream,
      progressStream,
      outputs: outputsPromise,
      stats: statsPromise,
    };
  }

  const outputStream = (async function* () {
    // Empty generator for non-streaming mode
  })();

  return {
    outputStream,
    progressStream,
    outputs: outputsPromise,
    stats: statsPromise,
  };
}
