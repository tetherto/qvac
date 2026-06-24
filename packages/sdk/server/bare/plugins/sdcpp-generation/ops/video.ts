import { VideoStableDiffusion } from "@qvac/diffusion-cpp";
import { getServerLogger } from "@/logging";
import {
  getModel,
  getModelEntry,
} from "@/server/bare/registry/model-registry";
import { getRequestRegistry, withRequestContext } from "@/server/bare/runtime";
import { generateServerRequestId } from "@/server/bare/runtime/request-id";
import { ModelOperationNotSupportedError } from "@/utils/errors-server";
import { ModelType } from "@/schemas";
import type {
  VideoRequest,
  VideoStreamResponse,
  VideoStats,
} from "@/schemas/sdcpp-config";

interface ResponseWithStats {
  stats?: VideoStats;
}

// The diffusion plugin instantiates `VideoStableDiffusion` when the model is
// loaded with `modelConfig.mode === "video"` and `ImgStableDiffusion` (or
// `EsrganUpscaler`) otherwise. Those have no video `run()` shape, so we refuse
// the call upfront with a structured error rather than letting a native-addon
// error propagate.
function asVideoModel(model: unknown, modelId: string): VideoStableDiffusion {
  if (model instanceof VideoStableDiffusion) {
    return model;
  }

  const entry = getModelEntry(modelId);
  const modelType =
    entry && !entry.isDelegated
      ? entry.local.modelType
      : ModelType.sdcppGeneration;
  throw new ModelOperationNotSupportedError(
    modelId,
    modelType,
    "video",
    ["diffusion"],
    [],
  );
}

export async function* video(
  request: VideoRequest,
): AsyncGenerator<VideoStreamResponse> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateServerRequestId(),
    kind: "diffusion",
    modelId: request.modelId,
  });
  const requestLogger = withRequestContext(getServerLogger(), ctx);
  const model = asVideoModel(getModel(request.modelId), request.modelId);

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

  const response = await model.run({
    mode: request.mode,
    prompt: request.prompt,
    ...(request.negative_prompt !== undefined && {
      negative_prompt: request.negative_prompt,
    }),
    ...(request.width !== undefined && { width: request.width }),
    ...(request.height !== undefined && { height: request.height }),
    ...(request.video_frames !== undefined && {
      video_frames: request.video_frames,
    }),
    ...(request.fps !== undefined && { fps: request.fps }),
    ...(request.seed !== undefined && { seed: request.seed }),
    ...(request.steps !== undefined && { steps: request.steps }),
    ...(request.sampling_method !== undefined && {
      sampling_method: request.sampling_method,
    }),
    ...(request.scheduler !== undefined && { scheduler: request.scheduler }),
    ...(request.cfg_scale !== undefined && { cfg_scale: request.cfg_scale }),
    ...(request.flow_shift !== undefined && { flow_shift: request.flow_shift }),
    ...(request.high_noise_steps !== undefined && {
      high_noise_steps: request.high_noise_steps,
    }),
    ...(request.high_noise_sampler !== undefined && {
      high_noise_sampler: request.high_noise_sampler,
    }),
    ...(request.high_noise_scheduler !== undefined && {
      high_noise_scheduler: request.high_noise_scheduler,
    }),
    ...(request.high_noise_cfg_scale !== undefined && {
      high_noise_cfg_scale: request.high_noise_cfg_scale,
    }),
    ...(request.high_noise_flow_shift !== undefined && {
      high_noise_flow_shift: request.high_noise_flow_shift,
    }),
    ...(request.moe_boundary !== undefined && {
      moe_boundary: request.moe_boundary,
    }),
    ...(request.vace_strength !== undefined && {
      vace_strength: request.vace_strength,
    }),
    ...(request.init_image !== undefined && {
      init_image: Buffer.from(request.init_image, "base64"),
    }),
    ...(request.strength !== undefined && {
      strength: request.strength,
    }),
    ...(request.control_frames !== undefined && {
      control_frames: request.control_frames.map((b64) =>
        Buffer.from(b64, "base64"),
      ),
    }),
    ...(request.vae_tiling !== undefined && { vae_tiling: request.vae_tiling }),
    ...(request.vae_tile_size !== undefined && {
      vae_tile_size: request.vae_tile_size,
    }),
    ...(request.vae_tile_overlap !== undefined && {
      vae_tile_overlap: request.vae_tile_overlap,
    }),
    ...(request.cache_mode !== undefined && { cache_mode: request.cache_mode }),
    ...(request.cache_preset !== undefined && {
      cache_preset: request.cache_preset,
    }),
    ...(request.cache_threshold !== undefined && {
      cache_threshold: request.cache_threshold,
    }),
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
