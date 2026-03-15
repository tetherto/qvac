import { getModel } from "@/server/bare/registry/model-registry";
import type {
  GenerationRequest,
  GenerationStreamResponse,
  DiffusionStats,
} from "@/schemas/sdcpp-config";

interface ResponseWithStats {
  stats?: DiffusionStats;
}

export async function* generation(
  request: GenerationRequest,
): AsyncGenerator<GenerationStreamResponse> {
  const model = getModel(request.modelId);

  const runParams: Record<string, unknown> = {
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
  };

  const initImage = request.init_image;
  if (initImage) {
    runParams["init_image"] = new Uint8Array(Buffer.from(initImage, "base64"));
    runParams["strength"] = request.strength;
  }

  const response = await model.run(runParams);

  let outputIndex = 0;

  for await (const chunk of response.iterate()) {
    if (chunk instanceof Uint8Array) {
      yield {
        type: "generationStream",
        data: Buffer.from(chunk).toString("base64"),
        outputIndex: outputIndex++,
      };
    } else if (typeof chunk === "string") {
      try {
        const tick = JSON.parse(chunk) as Record<string, unknown>;
        if ("step" in tick) {
          yield {
            type: "generationStream",
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
    type: "generationStream",
    done: true,
    stats: responseWithStats.stats ?? undefined,
  };
}
