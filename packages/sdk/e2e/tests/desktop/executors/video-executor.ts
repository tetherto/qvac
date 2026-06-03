import * as fs from "node:fs";
import * as path from "node:path";
import {
  video,
  type VideoClientParams,
} from "@qvac/sdk";
import {
  ValidationHelpers,
  type Expectation,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { videoTests } from "../../video-tests.js";

type VideoMode = "txt2vid" | "img2vid";

function readImageBytes(name: string): Uint8Array {
  const fileName = name.split("/").pop()!;
  const filePath = path.resolve(process.cwd(), "assets/images", fileName);
  return new Uint8Array(fs.readFileSync(filePath));
}

export class VideoExecutor extends AbstractModelExecutor<typeof videoTests> {
  pattern = /^video-/;

  protected handlers = Object.fromEntries(
    videoTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  protected async resolveParams(
    p: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { ...p };

    if (p.control_frames !== undefined) {
      if (
        !Array.isArray(p.control_frames) ||
        !p.control_frames.every((value) => typeof value === "string")
      ) {
        throw new Error(
          "control_frames in test params must be a string[] of image filenames",
        );
      }
      out.control_frames = (p.control_frames as string[]).map(readImageBytes);
    }

    if (p.init_image !== undefined) {
      if (typeof p.init_image !== "string") {
        throw new Error(
          "init_image in test params must be an image filename",
        );
      }
      out.init_image = readImageBytes(p.init_image);
    }

    return out;
  }

  protected buildParams(
    modelId: string,
    p: Record<string, unknown>,
  ): VideoClientParams {
    const mode: VideoMode = p.mode === "img2vid" ? "img2vid" : "txt2vid";
    const params: VideoClientParams = mode === "img2vid"
      ? {
          modelId,
          mode,
          prompt: p.prompt as string,
          init_image: p.init_image as Uint8Array,
        } as VideoClientParams
      : {
          modelId,
          mode,
          prompt: p.prompt as string,
        };

    if (p.negative_prompt != null) params.negative_prompt = p.negative_prompt as string;
    if (p.width != null) params.width = p.width as number;
    if (p.height != null) params.height = p.height as number;
    if (p.video_frames != null) params.video_frames = p.video_frames as number;
    if (p.fps != null) params.fps = p.fps as number;
    if (p.seed != null) params.seed = p.seed as number;
    if (p.steps != null) params.steps = p.steps as number;
    if (p.sampling_method != null) {
      params.sampling_method = p.sampling_method as VideoClientParams["sampling_method"];
    }
    if (p.scheduler != null) {
      params.scheduler = p.scheduler as VideoClientParams["scheduler"];
    }
    if (p.cfg_scale != null) params.cfg_scale = p.cfg_scale as number;
    if (p.flow_shift != null) params.flow_shift = p.flow_shift as number;
    if (p.high_noise_steps != null) params.high_noise_steps = p.high_noise_steps as number;
    if (p.high_noise_sampler != null) {
      params.high_noise_sampler = p.high_noise_sampler as VideoClientParams["high_noise_sampler"];
    }
    if (p.high_noise_scheduler != null) {
      params.high_noise_scheduler = p.high_noise_scheduler as VideoClientParams["high_noise_scheduler"];
    }
    if (p.high_noise_cfg_scale != null) params.high_noise_cfg_scale = p.high_noise_cfg_scale as number;
    if (p.high_noise_flow_shift != null) params.high_noise_flow_shift = p.high_noise_flow_shift as number;
    if (p.moe_boundary != null) params.moe_boundary = p.moe_boundary as number;
    if (p.vace_strength != null) params.vace_strength = p.vace_strength as number;
    if (p.control_frames != null) params.control_frames = p.control_frames as Uint8Array[];
    if (mode === "img2vid" && p.strength != null) {
      (params as VideoClientParams & { strength?: number }).strength = p.strength as number;
    }
    if (p.vae_tiling != null) params.vae_tiling = p.vae_tiling as boolean;
    if (p.vae_tile_size != null) {
      params.vae_tile_size = p.vae_tile_size as VideoClientParams["vae_tile_size"];
    }
    if (p.vae_tile_overlap != null) params.vae_tile_overlap = p.vae_tile_overlap as number;
    if (p.cache_mode != null) {
      params.cache_mode = p.cache_mode as VideoClientParams["cache_mode"];
    }
    if (p.cache_preset != null) params.cache_preset = p.cache_preset as string;
    if (p.cache_threshold != null) params.cache_threshold = p.cache_threshold as number;

    return params;
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = await this.resolveParams(params as Record<string, unknown>);

    try {
      const modelId = await this.resources.ensureLoaded(
        p.mode === "img2vid" ? "video-img2vid" : "video",
      );
      const run = video(this.buildParams(modelId, p));
      const outputs = await run.outputs;
      const stats = await run.stats;

      return ValidationHelpers.validate(
        { outputs, stats },
        expectation as Expectation,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const exp = expectation as Expectation;
      if (exp.validation === "throws-error") {
        return ValidationHelpers.validate(errorMsg, exp);
      }
      return { passed: false, output: `Video generation failed: ${errorMsg}` };
    }
  }
}
