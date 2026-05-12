import {
  upscaleStreamResponseSchema,
  type UpscaleClientParams,
  type UpscaleStats,
  type UpscaleStreamRequest,
} from "@/schemas/sdcpp-config";
import { stream as streamRpc } from "@/client/rpc/rpc-client";
import { decodeBase64, encodeBase64 } from "@/utils/encoding";
import { StreamEndedError } from "@/utils/errors-client";

interface UpscaleResult {
  outputs: Promise<Uint8Array[]>;
  stats: Promise<UpscaleStats | undefined>;
}

export function upscale(params: UpscaleClientParams): UpscaleResult {
  const request: UpscaleStreamRequest = {
    modelId: params.modelId,
    image: encodeBase64(params.image),
    ...(params.repeats !== undefined && { repeats: params.repeats }),
    type: "upscaleStream",
  };

  let statsResolver: (value: UpscaleStats | undefined) => void = () => {};
  let statsRejecter: (error: unknown) => void = () => {};
  const statsPromise = new Promise<UpscaleStats | undefined>(
    (resolve, reject) => {
      statsResolver = resolve;
      statsRejecter = reject;
    },
  );
  statsPromise.catch(() => {});

  let outputsResolver: (value: Uint8Array[]) => void = () => {};
  let outputsRejecter: (error: unknown) => void = () => {};
  const outputsPromise = new Promise<Uint8Array[]>((resolve, reject) => {
    outputsResolver = resolve;
    outputsRejecter = reject;
  });
  outputsPromise.catch(() => {});

  const collectedBuffers: Uint8Array[] = [];

  async function processResponses() {
    let sawDone = false;
    try {
      for await (const response of streamRpc(request)) {
        if (
          response &&
          typeof response === "object" &&
          "type" in response &&
          response.type === "upscaleStream"
        ) {
          const parsed = upscaleStreamResponseSchema.parse(response);

          if (parsed.data) {
            collectedBuffers.push(decodeBase64(parsed.data));
          }

          if (parsed.done) {
            sawDone = true;
            statsResolver(parsed.stats);
            outputsResolver(collectedBuffers);
          }
        }
      }

      if (!sawDone) {
        const error = new StreamEndedError();
        statsRejecter(error);
        outputsRejecter(error);
      }
    } catch (error) {
      statsRejecter(error);
      outputsRejecter(error);
    }
  }

  void processResponses();

  return {
    outputs: outputsPromise,
    stats: statsPromise,
  };
}
