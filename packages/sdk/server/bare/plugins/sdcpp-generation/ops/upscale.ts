import { getModel } from "@/server/bare/registry/model-registry";
import { ModelLoadFailedError } from "@/utils/errors-server";
import type {
  UpscaleRequest,
  UpscaleStats,
  UpscaleStreamResponse,
} from "@/schemas/sdcpp-config";

interface ResponseWithStats {
  stats?: UpscaleStats;
}

interface UpscalerModel {
  upscale(
    imageBytes: Uint8Array,
    options?: { repeats?: number },
  ): Promise<{
    iterate(): AsyncGenerator<unknown>;
    stats?: UpscaleStats;
  }>;
}

// The diffusion plugin instantiates `EsrganUpscaler` when the model is loaded
// with `modelConfig.mode === "upscale"` and `ImgStableDiffusion` otherwise. The
// latter has no `.upscale()` method, so we refuse the call upfront with a
// structured error rather than letting a TypeError propagate.
function asUpscalerModel(model: unknown, modelId: string): UpscalerModel {
  if (
    !model ||
    typeof model !== "object" ||
    typeof (model as { upscale?: unknown }).upscale !== "function"
  ) {
    throw new ModelLoadFailedError(
      `Model "${modelId}" is not loaded in upscale mode. ` +
        'Re-load the model with `modelConfig: { mode: "upscale" }` ' +
        "before invoking upscale().",
    );
  }
  return model as UpscalerModel;
}

export async function* upscale(
  request: UpscaleRequest,
): AsyncGenerator<UpscaleStreamResponse> {
  const model = asUpscalerModel(getModel(request.modelId), request.modelId);
  const response = await model.upscale(
    Buffer.from(request.image, "base64"),
    request.repeats === undefined ? undefined : { repeats: request.repeats },
  );

  let outputIndex = 0;
  for await (const chunk of response.iterate()) {
    if (chunk instanceof Uint8Array) {
      yield {
        type: "upscaleStream",
        data: Buffer.from(chunk).toString("base64"),
        outputIndex: outputIndex++,
      };
    }
  }

  const responseWithStats = response as ResponseWithStats;
  yield {
    type: "upscaleStream",
    done: true,
    stats: responseWithStats.stats ?? undefined,
  };
}
