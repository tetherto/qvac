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

/**
 * Runs standalone ESRGAN upscaling on an arbitrary PNG/JPEG image.
 *
 * The model must have been loaded with `modelType: "diffusion"` and
 * `modelConfig.mode: "upscale"` — calling `upscale()` against a model
 * loaded in default (`mode: "diffusion"`) mode throws
 * `ModelOperationNotSupportedError` upfront.
 *
 * `outputs` always resolves to length 1: `repeats` runs N passes
 * internally and emits a single final image at `source * scale^repeats`
 * dimensions. The `Uint8Array[]` shape reserves headroom for future
 * multi-output variants.
 *
 * @param params - `{ modelId, image, repeats? }`. `image` is raw PNG/JPEG
 *   bytes; the client base64-encodes them on the wire.
 * @returns `{ outputs, stats }` — `outputs` resolves to a single-element
 *   array containing the final upscaled PNG; `stats` resolves to
 *   addon-side stats (load/upscale ms, final width/height, repeats
 *   actually executed, etc.).
 * @throws {ModelOperationNotSupportedError} If the model was not loaded
 *   with `mode: "upscale"`.
 * @throws {StreamEndedError} If the RPC stream closes without emitting a
 *   terminal `done` chunk.
 *
 * @example
 * ```ts
 * const modelId = await loadModel(REALESRGAN_X4PLUS_ANIME_6B, {
 *   modelType: "diffusion",
 *   modelConfig: { mode: "upscale", upscaler: { tile_size: 128 } },
 * });
 * const pngBytes = fs.readFileSync("input.png");
 * const { outputs, stats } = upscale({ modelId, image: pngBytes, repeats: 2 });
 * const [upscaledPng] = await outputs;
 * fs.writeFileSync("upscaled.png", upscaledPng);
 * console.log(await stats);
 * ```
 */
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
