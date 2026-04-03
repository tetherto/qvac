import { getModel } from "@/server/bare/registry/model-registry";
import type {
  DiffusionRequest,
  DiffusionStreamResponse,
  DiffusionStats,
} from "@/schemas/sdcpp-config";

interface ResponseWithStats {
  stats?: DiffusionStats;
}

export async function* diffusion(
  request: DiffusionRequest,
): AsyncGenerator<DiffusionStreamResponse> {
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

  let outputIndex = 0;

  for await (const chunk of response.iterate()) {
    if (chunk instanceof Uint8Array) {
      yield {
        type: "diffusionStream",
        data: Buffer.from(chunk).toString("base64"),
        outputIndex: outputIndex++,
      };
    } else if (typeof chunk === "string") {
      try {
        const tick = JSON.parse(chunk) as Record<string, unknown>;
        if ("step" in tick) {
          yield {
            type: "diffusionStream",
            step: tick["step"] as number,
            totalSteps: tick["total"] as number,
            elapsedMs: tick["elapsed_ms"] as number,
          };
        }
      } catch {
        // Non-JSON string output — skip
      }
    }
  }

  const responseWithStats = response as unknown as ResponseWithStats;
  yield {
    type: "diffusionStream",
    done: true,
    stats: responseWithStats.stats ?? undefined,
  };
}
