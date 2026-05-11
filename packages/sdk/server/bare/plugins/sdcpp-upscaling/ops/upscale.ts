import { getModel } from "@/server/bare/registry/model-registry";
import type {
  UpscaleRequest,
  UpscaleStats,
  UpscaleStreamResponse,
} from "@/schemas/sdcpp-upscaling";

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

export async function* upscale(
  request: UpscaleRequest,
): AsyncGenerator<UpscaleStreamResponse> {
  const model = getModel(request.modelId) as unknown as UpscalerModel;
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
