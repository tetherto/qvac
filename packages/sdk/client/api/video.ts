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

export function video(params: VideoClientParams): VideoResult {
  const {
    control_frames,
    ...rest
  } = params;
  const requestId = generateClientRequestId();

  const request: VideoStreamRequest = {
    ...rest,
    ...(control_frames !== undefined && {
      control_frames: control_frames.map(encodeBase64),
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
