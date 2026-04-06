import {
  diffusionStreamResponseSchema,
  type DiffusionStreamRequest,
  type DiffusionClientParams,
  type DiffusionStats,
} from "@/schemas";
import { stream as streamRpc } from "@/client/rpc/rpc-client";

export interface DiffusionProgressTick {
  step: number;
  totalSteps: number;
  elapsedMs: number;
}

interface DiffusionResult {
  progressStream: AsyncGenerator<DiffusionProgressTick>;
  outputs: Promise<Buffer[]>;
  stats: Promise<DiffusionStats | undefined>;
}

/**
 * Generate images using a loaded diffusion model.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const { outputs, stats } = diffusion({ modelId, prompt: "a cat" });
 * const buffers = await outputs;
 * fs.writeFileSync("output.png", buffers[0]);
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
  const request: DiffusionStreamRequest = {
    type: "diffusionStream",
    ...params,
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
  const collectedBuffers: Buffer[] = [];
  let progressDone = false;
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
            collectedBuffers.push(Buffer.from(parsed.data, "base64"));
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
