import {
  videoStreamResponseSchema,
  type VideoStreamRequest,
  type VideoClientParams,
  type VideoStats,
} from "@/schemas";
import { stream as streamRpc } from "@/client/rpc/rpc-client";
import { generateClientRequestId } from "@/client/api/client-request-id";
import { decodeBase64, encodeBase64 } from "@/utils/encoding";

export interface VideoProgressTick {
  step: number;
  totalSteps: number;
  elapsedMs: number;
}

export interface VideoResult {
  requestId: string;
  progressStream: AsyncGenerator<VideoProgressTick>;
  outputs: Promise<Uint8Array[]>;
  stats: Promise<VideoStats | undefined>;
}

/**
 * Generates a video using a loaded video diffusion model.
 *
 * @param params - Video request parameters (model, prompt, dimensions, frame count, fps, sampler, seed, etc.).
 * @returns A result object exposing `requestId` (stable identifier for this in-flight generation), `progressStream` (async iterator of `{ step, totalSteps, elapsedMs }`), `outputs` (promise of the generated video buffers, typically a single AVI file), and `stats` (promise of generation statistics).
 *
 * Supports `txt2vid` (text-to-video) and `img2vid` (image-to-video). For `img2vid`,
 * load the Wan pipeline with `modelConfig.clipVisionModelSrc` set to
 * `clip_vision_h.safetensors`. On React Native, prefer a `modelId` loaded with a
 * `delegate` since the bundled video diffusion models are too large for typical mobile devices.
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
 * @example Cancellation via requestId
 * ```typescript
 * const { requestId, outputs } = video({ modelId, mode: "txt2vid", prompt: "..." });
 * // ...later
 * await cancel(requestId);
 * ```
 */
export function video(params: VideoClientParams): VideoResult {
  const requestId = generateClientRequestId();

  const { control_frames, init_image, ...rest } = params;
  const request: VideoStreamRequest = {
    ...rest,
    ...(control_frames !== undefined && {
      control_frames: control_frames.map(encodeBase64),
    }),
    ...(init_image !== undefined && {
      init_image: encodeBase64(init_image),
    }),
    type: "videoStream",
    requestId,
  };

  let statsResolver: (value: VideoStats | undefined) => void = () => {};
  let statsRejecter: (error: unknown) => void = () => {};
  const statsPromise = new Promise<VideoStats | undefined>((resolve, reject) => {
    statsResolver = resolve;
    statsRejecter = reject;
  });
  statsPromise.catch(() => {});

  const progressQueue: VideoProgressTick[] = [];
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

  async function processResponses() {
    try {
      for await (const response of streamRpc(request)) {
        if (
          response &&
          typeof response === "object" &&
          "type" in response &&
          response.type === "videoStream"
        ) {
          const parsed = videoStreamResponseSchema.parse(response);

          if (parsed.step != null && parsed.totalSteps != null && parsed.elapsedMs != null) {
            progressQueue.push({
              step: parsed.step,
              totalSteps: parsed.totalSteps,
              elapsedMs: parsed.elapsedMs,
            });
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
  }

  void processResponses();

  const progressStream = (async function* (): AsyncGenerator<VideoProgressTick> {
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
    requestId,
    progressStream,
    outputs: outputsPromise,
    stats: statsPromise,
  };
}
