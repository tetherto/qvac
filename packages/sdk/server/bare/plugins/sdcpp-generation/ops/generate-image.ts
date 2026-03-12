import { getModel } from "@/server/bare/registry";
import type {
  GenerateImageRequest,
  GenerateImageStreamResponse,
} from "@/schemas/sdcpp-config";

export async function* generateImage(
  request: GenerateImageRequest,
): AsyncGenerator<GenerateImageStreamResponse> {
  const model = getModel(request.modelId);
  const response = await model.run({
    prompt: request.prompt,
    negative_prompt: request.negative_prompt,
    width: request.width,
    height: request.height,
    steps: request.steps,
    cfg_scale: request.cfg_scale,
    guidance: request.guidance,
    sampling_method: request.sampling_method,
    scheduler: request.scheduler,
    seed: request.seed,
    batch_count: request.batch_count,
    vae_tiling: request.vae_tiling,
    cache_preset: request.cache_preset,
  });

  let imageIndex = 0;

  for await (const data of response.iterate()) {
    if (data instanceof Uint8Array) {
      yield {
        type: "generateImageStream",
        image: Buffer.from(data).toString("base64"),
        imageIndex: imageIndex++,
      };
    } else if (typeof data === "string") {
      try {
        const tick = JSON.parse(data);
        if ("step" in tick) {
          yield {
            type: "generateImageStream",
            step: tick.step,
            totalSteps: tick.total,
            elapsedMs: tick.elapsed_ms,
          };
        }
      } catch (_) {
        // Non-JSON string output — skip
      }
    }
  }

  yield {
    type: "generateImageStream",
    done: true,
    stats: response.stats ?? undefined,
  };
}
