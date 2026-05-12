import { EsrganUpscaler } from "@qvac/diffusion-cpp";
import {
  getModel,
  getModelEntry,
} from "@/server/bare/registry/model-registry";
import { ModelOperationNotSupportedError } from "@/utils/errors-server";
import { ModelType } from "@/schemas";
import type {
  UpscaleRequest,
  UpscaleStats,
  UpscaleStreamResponse,
} from "@/schemas/sdcpp-config";

interface ResponseWithStats {
  stats?: UpscaleStats;
}

// The diffusion plugin instantiates `EsrganUpscaler` when the model is loaded
// with `modelConfig.mode === "upscale"` and `ImgStableDiffusion` otherwise. The
// latter has no `.upscale()` method, so we refuse the call upfront with a
// structured error rather than letting a TypeError propagate.
function asUpscalerModel(model: unknown, modelId: string): EsrganUpscaler {
  if (model instanceof EsrganUpscaler) {
    return model;
  }

  const entry = getModelEntry(modelId);
  const modelType =
    entry && !entry.isDelegated ? entry.local.modelType : ModelType.sdcppGeneration;
  throw new ModelOperationNotSupportedError(
    modelId,
    modelType,
    "upscale",
    ["diffusion"],
    [],
    new Error(
      'Model is not loaded in upscale mode. Re-load the model with `modelConfig: { mode: "upscale" }` before invoking upscale().',
    ),
  );
}

export async function* upscale(
  request: UpscaleRequest,
): AsyncGenerator<UpscaleStreamResponse> {
  const model = asUpscalerModel(getModel(request.modelId), request.modelId);
  const response = await model.upscale(
    Buffer.from(request.image, "base64"),
    request.repeats === undefined ? undefined : { repeats: request.repeats },
  );

  // `outputIndex` is currently always sequential (Bare RPC delivers stream
  // chunks in order, and the addon emits at most one PNG per repeat pass).
  // Emitting it on the wire keeps parity with diffusionStream and gives
  // future consumers (e.g. UIs that need a stable per-image identifier
  // across reordered renderers) a hook without a wire-format change.
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

  const responseWithStats = response as unknown as ResponseWithStats;
  yield {
    type: "upscaleStream",
    done: true,
    stats: responseWithStats.stats ?? undefined,
  };
}
