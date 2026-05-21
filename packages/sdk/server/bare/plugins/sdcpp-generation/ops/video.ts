import { getServerLogger } from "@/logging";
import { getModel, type AnyModel } from "@/server/bare/registry/model-registry";
import { getRequestRegistry, withRequestContext } from "@/server/bare/runtime";
import { generateServerRequestId } from "@/server/bare/runtime/request-id";
import type {
  VideoRequest,
  VideoStreamResponse,
  VideoStats,
} from "@/schemas/sdcpp-config";

interface CancellableVideoModel extends AnyModel {
  cancel(): Promise<void>;
}

interface ResponseWithStats {
  stats?: VideoStats;
}

export async function* video(
  request: VideoRequest,
): AsyncGenerator<VideoStreamResponse> {
  await using ctx = getRequestRegistry().begin({
    requestId: request.requestId ?? generateServerRequestId(),
    kind: "diffusion",
    modelId: request.modelId,
  });
  const requestLogger = withRequestContext(getServerLogger(), ctx);
  const model = getModel(request.modelId) as CancellableVideoModel;

  const onAbort = () => {
    model.cancel().catch((err: unknown) => {
      requestLogger.warn(
        `[cancel] model.cancel() rejected during abort for modelId=${request.modelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) onAbort();
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener("abort", onAbort);
  });

  const init_image = request.init_image
    ? Buffer.from(request.init_image, "base64")
    : undefined;

  const end_image = request.end_image
    ? Buffer.from(request.end_image, "base64")
    : undefined;

  const control_frames = request.control_frames
    ? request.control_frames.map((b64) => Buffer.from(b64, "base64"))
    : undefined;

  const response = await model.run({
    mode: request.mode,
    prompt: request.prompt,
    negative_prompt: request.negative_prompt,
    width: request.width,
    height: request.height,
    video_frames: request.video_frames,
    fps: request.fps,
    seed: request.seed,
    steps: request.steps,
    sampling_method: request.sampling_method,
    scheduler: request.scheduler,
    cfg_scale: request.cfg_scale,
    flow_shift: request.flow_shift,
    high_noise_steps: request.high_noise_steps,
    high_noise_sampler: request.high_noise_sampler,
    high_noise_scheduler: request.high_noise_scheduler,
    high_noise_cfg_scale: request.high_noise_cfg_scale,
    high_noise_flow_shift: request.high_noise_flow_shift,
    moe_boundary: request.moe_boundary,
    strength: request.strength,
    vace_strength: request.vace_strength,
    init_image,
    end_image,
    control_frames,
    vae_tiling: request.vae_tiling,
    vae_tile_size: request.vae_tile_size,
    vae_tile_overlap: request.vae_tile_overlap,
    cache_mode: request.cache_mode,
    cache_preset: request.cache_preset,
    cache_threshold: request.cache_threshold,
  });

  let outputIndex = 0;

  for await (const chunk of response.iterate()) {
    if (ctx.signal.aborted) break;
    if (chunk instanceof Uint8Array) {
      yield {
        type: "videoStream",
        data: Buffer.from(chunk).toString("base64"),
        outputIndex: outputIndex++,
      };
    } else if (typeof chunk === "string") {
      try {
        const tick = JSON.parse(chunk) as Record<string, unknown>;
        if ("step" in tick) {
          yield {
            type: "videoStream",
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
    type: "videoStream",
    done: true,
    stats: responseWithStats.stats ?? undefined,
  };
}
