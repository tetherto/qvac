import { diffusion, upscale, type DiffusionClientParams } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
  type HandlerFn,
  type ExtractTest,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import {
  diffusionTests,
  diffusionBasicTxt2img,
  diffusionDefaultSize,
  diffusionNegativePrompt,
  diffusionCfgScale,
  diffusionSamplerEulerA,
  diffusionSamplerHeun,
  diffusionSchedulerKarras,
  diffusionSeedReproducibility,
  diffusionBatchCount,
  diffusionBasicImg2img,
  diffusionImg2imgImgCfgScale,
  diffusionImg2imgVsTxt2imgBaseline,
  diffusionImg2imgInvalidStrength,
  diffusionStreaming,
  diffusionStreamingProgress,
  diffusionStatsPresent,
  diffusionFaAccepted,
  diffusionFaDisabledAccepted,
  diffusionFusionFlux2Basic,
  diffusionEsrganUpscaleX4,
  diffusionStandaloneUpscalerX4,
  diffusionEmptyPrompt,
} from "../../diffusion-tests.js";

// Min byte divergence vs same-seed/prompt txt2img baseline. Output is
// bit-exact at fixed seed (see seedReproducibility), so 1% is well above
// noise and catches a silent fallback when init_image / init_images is
// dropped server-side.
const MIN_DIVERGENCE_RATIO = 0.01;

// Rolling param shape across resolveParams → buildParams → diffusion().
// Asset fields are a `string` filename before resolveParams() and `Uint8Array`
// after. Index signature is required so test-specific param literals are
// assignable at the framework dispatch boundary.
export interface DiffusionParams {
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg_scale?: number;
  img_cfg_scale?: number;
  guidance?: number;
  sampling_method?: DiffusionClientParams["sampling_method"];
  scheduler?: DiffusionClientParams["scheduler"];
  seed?: number;
  batch_count?: number;
  vae_tiling?: boolean;
  increase_ref_index?: boolean;
  auto_resize_ref_image?: boolean;
  lora?: string;
  strength?: number;
  upscale?: DiffusionClientParams["upscale"];
  init_image?: string | Uint8Array;
  init_images?: string[] | Uint8Array[];
  image?: string | Uint8Array;
  repeats?: number;
  [key: string]: unknown;
}

export class DiffusionExecutor extends AbstractModelExecutor<typeof diffusionTests> {
  pattern = /^diffusion-/;

  // Exhaustive testId → handler map. Most tests share `runBasic`; comparative
  // and streaming cases have dedicated methods. The `Required<...>` annotation
  // turns "missing handler" into a TS compile error.
  protected handlers: Required<{
    [K in (typeof diffusionTests)[number]["testId"]]: HandlerFn<
      ExtractTest<typeof diffusionTests, K>
    >;
  }> = {
    [diffusionBasicTxt2img.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionDefaultSize.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionNegativePrompt.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionCfgScale.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionSamplerEulerA.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionSamplerHeun.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionSchedulerKarras.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionBatchCount.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionBasicImg2img.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionImg2imgImgCfgScale.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionImg2imgInvalidStrength.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionStreaming.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionEmptyPrompt.testId]: this.runBasic.bind(this, "diffusion"),
    [diffusionFaAccepted.testId]: this.runBasic.bind(this, "diffusion-fa"),
    [diffusionFaDisabledAccepted.testId]: this.runBasic.bind(this, "diffusion-fa-disabled"),
    [diffusionEsrganUpscaleX4.testId]: this.runBasic.bind(this, "diffusion-esrgan"),
    [diffusionSeedReproducibility.testId]: this.seedReproducibility.bind(this),
    [diffusionStreamingProgress.testId]: this.streamingProgress.bind(this),
    [diffusionStatsPresent.testId]: this.statsPresent.bind(this),
    [diffusionImg2imgVsTxt2imgBaseline.testId]: this.img2imgVsTxt2imgBaseline.bind(this),
    [diffusionFusionFlux2Basic.testId]: this.fusionFlux2Basic.bind(this),
    [diffusionStandaloneUpscalerX4.testId]: this.standaloneUpscalerX4.bind(this),
  };

  // Subclasses override this to resolve string filenames in init_image /
  // init_images / image to Uint8Array bytes via their platform's filesystem.
  protected async resolveParams(p: DiffusionParams): Promise<DiffusionParams> {
    return p;
  }

  // ----- handlers -----

  // Unified path for every test that just runs diffusion() and validates
  // outputs against the expectation. `resourceKey` selects which preconfigured
  // model to load (FLUX.2 Klein, FLUX.2 with FA, SD+ESRGAN, ...).
  async runBasic(
    resourceKey: string,
    params: DiffusionParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    const p = await this.resolveParams(params);
    const modelId = await this.resources.ensureLoaded(resourceKey);

    try {
      const { outputs } = diffusion(this.buildParams(modelId, p));
      const buffers = await outputs;
      return ValidationHelpers.validate(buffers, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (expectation.validation === "throws-error") {
        return ValidationHelpers.validate(errorMsg, expectation);
      }
      return { passed: false, output: `Diffusion failed: ${errorMsg}` };
    }
  }

  async seedReproducibility(params: DiffusionParams): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("diffusion");

    try {
      const genParams = this.buildParams(modelId, params);

      const buffers1 = await diffusion(genParams).outputs;
      const buffers2 = await diffusion(genParams).outputs;

      if (buffers1.length === 0 || buffers2.length === 0) {
        return { passed: false, output: "No outputs generated" };
      }

      const a = buffers1[0]!;
      const b = buffers2[0]!;
      const match = a.length === b.length && a.every((byte, i) => byte === b[i]);

      return {
        passed: match,
        output: match
          ? "Same seed produces identical output"
          : `Outputs differ: ${a.length} vs ${b.length} bytes`,
      };
    } catch (error) {
      return this.fail("Seed reproducibility", error);
    }
  }

  async streamingProgress(params: DiffusionParams): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("diffusion");

    try {
      const { progressStream, outputs, stats } = diffusion(
        this.buildParams(modelId, params),
      );

      const ticks: { step: number; totalSteps: number; elapsedMs: number }[] = [];
      for await (const tick of progressStream) ticks.push(tick);

      const buffers = await outputs;
      const finalStats = await stats;

      const hasOutputs = buffers.length > 0;
      const hasStats = finalStats != null;
      const hasProgress = ticks.length > 0;
      const progressValid = ticks.every(
        (t) =>
          typeof t.step === "number" &&
          typeof t.totalSteps === "number" &&
          typeof t.elapsedMs === "number",
      );

      return {
        passed: hasOutputs && hasStats && hasProgress && progressValid,
        output: `Received ${buffers.length} output(s), ${ticks.length} progress tick(s), stats: ${hasStats ? "present" : "missing"}, progress valid: ${progressValid}`,
      };
    } catch (error) {
      return this.fail("Streaming progress", error);
    }
  }

  async statsPresent(params: DiffusionParams): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("diffusion");

    try {
      const { outputs, stats } = diffusion(this.buildParams(modelId, params));
      await outputs;
      const finalStats = await stats;

      if (!finalStats) {
        return { passed: false, output: "Stats missing from response" };
      }

      const passed =
        typeof finalStats.totalSteps === "number" ||
        typeof finalStats.generationMs === "number" ||
        typeof finalStats.modelLoadMs === "number";

      return { passed, output: `Stats present: ${JSON.stringify(finalStats)}` };
    } catch (error) {
      return this.fail("Stats", error);
    }
  }

  // Compare img2img vs same-seed/prompt baseline with init_image dropped.
  // If the server silently drops init_image, byte delta collapses and this fails.
  async img2imgVsTxt2imgBaseline(params: DiffusionParams): Promise<TestResult> {
    if (params.seed === undefined) {
      return {
        passed: false,
        output: "img2img-vs-txt2img test requires a fixed seed to compare against baseline",
      };
    }
    if (params.init_image === undefined) {
      return { passed: false, output: "img2img-vs-txt2img test requires init_image" };
    }
    return this.compareWithBaseline(params, "init_image", "img2img");
  }

  // Compare fusion vs same-seed/prompt baseline with init_images dropped.
  // If the addon silently ignores init_images, byte delta collapses and this fails.
  async fusionFlux2Basic(params: DiffusionParams): Promise<TestResult> {
    if (params.seed === undefined) {
      return {
        passed: false,
        output: "fusion test requires a fixed seed to compare against baseline",
      };
    }
    return this.compareWithBaseline(params, "init_images", "Fusion");
  }

  async standaloneUpscalerX4(
    params: DiffusionParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    const p = await this.resolveParams(params);
    const modelId = await this.resources.ensureLoaded("upscaler");

    if (!(p.image instanceof Uint8Array)) {
      return { passed: false, output: "Standalone upscaler test requires image bytes" };
    }

    try {
      const { outputs } = upscale({
        modelId,
        image: p.image,
        ...(p.repeats !== undefined && { repeats: p.repeats }),
      });
      const buffers = await outputs;
      return ValidationHelpers.validate(buffers, expectation);
    } catch (error) {
      return this.fail("Standalone upscaler", error);
    }
  }

  // ----- private helpers -----

  // Translate the rolling DiffusionParams shape into the SDK's strict request
  // type. All SDK fields are passed through verbatim; init_image / init_images
  // must be Uint8Array by the time we reach here (resolveParams converts them).
  protected buildParams(
    modelId: string,
    p: DiffusionParams,
  ): DiffusionClientParams {
    const params: Omit<DiffusionClientParams, "init_image" | "init_images"> = {
      modelId,
      prompt: p.prompt,
    };

    if (p.negative_prompt !== undefined) params.negative_prompt = p.negative_prompt;
    if (p.width !== undefined) params.width = p.width;
    if (p.height !== undefined) params.height = p.height;
    if (p.steps !== undefined) params.steps = p.steps;
    if (p.cfg_scale !== undefined) params.cfg_scale = p.cfg_scale;
    if (p.img_cfg_scale !== undefined) params.img_cfg_scale = p.img_cfg_scale;
    if (p.guidance !== undefined) params.guidance = p.guidance;
    if (p.sampling_method !== undefined) params.sampling_method = p.sampling_method;
    if (p.scheduler !== undefined) params.scheduler = p.scheduler;
    if (p.seed !== undefined) params.seed = p.seed;
    if (p.batch_count !== undefined) params.batch_count = p.batch_count;
    if (p.vae_tiling !== undefined) params.vae_tiling = p.vae_tiling;
    if (p.increase_ref_index !== undefined) params.increase_ref_index = p.increase_ref_index;
    if (p.auto_resize_ref_image !== undefined) params.auto_resize_ref_image = p.auto_resize_ref_image;
    if (p.lora !== undefined) params.lora = p.lora;
    if (p.strength !== undefined) params.strength = p.strength;
    if (p.upscale !== undefined) params.upscale = p.upscale;

    if (p.init_image !== undefined && p.init_images !== undefined) {
      throw new Error(
        "Test params cannot set both init_image and init_images (mutually exclusive).",
      );
    }
    if (p.init_images !== undefined) {
      if (!isUint8ArrayList(p.init_images)) {
        throw new Error("init_images must be Uint8Array[] by the time it reaches buildParams");
      }
      return { ...params, init_images: p.init_images };
    }
    if (p.init_image !== undefined) {
      if (!(p.init_image instanceof Uint8Array)) {
        throw new Error("init_image must be Uint8Array by the time it reaches buildParams");
      }
      return { ...params, init_image: p.init_image };
    }
    return params;
  }

  // Single-image vs multi-image baseline-divergence comparison. `dropField`
  // names the input that gets nulled out for the baseline run; `label` is the
  // human-readable name used in the result message.
  private async compareWithBaseline(
    params: DiffusionParams,
    dropField: "init_image" | "init_images",
    label: string,
  ): Promise<TestResult> {
    const p = await this.resolveParams(params);
    const modelId = await this.resources.ensureLoaded("diffusion");

    try {
      const variantParams = this.buildParams(modelId, p);
      const baselineParams = this.buildParams(modelId, {
        ...p,
        [dropField]: undefined,
      });

      const variant = await diffusion(variantParams).outputs;
      const baseline = await diffusion(baselineParams).outputs;

      if (variant.length === 0 || baseline.length === 0) {
        return {
          passed: false,
          output: `Missing output(s): ${label}=${variant.length}, baseline=${baseline.length}`,
        };
      }

      // Guard against silent dimension mismatch (e.g. backend honoring
      // init_image dims instead of requested width/height). PNG byte length
      // varies by content/compression, so IHDR width/height is the only
      // reliable invariant for cross-output comparison.
      const dimErr = this.assertEqualPngDimensions(variant[0]!, baseline[0]!);
      if (dimErr) return dimErr;

      const diff = this.byteDiffRatio(variant[0]!, baseline[0]!);
      const passed = diff > MIN_DIVERGENCE_RATIO;
      const deltaPct = (diff * 100).toFixed(2);

      return {
        passed,
        output: passed
          ? `${label} output differs from txt2img baseline (${deltaPct}% byte delta)`
          : `${label} output matches txt2img baseline too closely (${deltaPct}% byte delta) — ${dropField} likely dropped server-side`,
      };
    } catch (error) {
      return this.fail(`${label} comparison`, error);
    }
  }

  private fail(label: string, error: unknown): TestResult {
    const msg = error instanceof Error ? error.message : String(error);
    return { passed: false, output: `${label} failed: ${msg}` };
  }

  // PNG dimensions live in the IHDR chunk: bytes 16..23 of the file (8-byte
  // signature + 4-byte length + 4-byte "IHDR" + 4 width + 4 height).
  private readPngDims(
    buf: Uint8Array,
  ): { width: number; height: number } | null {
    if (buf.length < 24) return null;
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }

  private assertEqualPngDimensions(
    left: Uint8Array,
    right: Uint8Array,
  ): TestResult | null {
    const l = this.readPngDims(left);
    const r = this.readPngDims(right);
    if (!l || !r) {
      return { passed: false, output: "One of the outputs is not a valid PNG" };
    }
    if (l.width !== r.width || l.height !== r.height) {
      return {
        passed: false,
        output: `Output dimensions mismatch: ${l.width}x${l.height} vs ${r.width}x${r.height} — comparison is only meaningful at equal dimensions`,
      };
    }
    return null;
  }

  private byteDiffRatio(left: Uint8Array, right: Uint8Array): number {
    const maxLength = Math.max(left.length, right.length);
    if (maxLength === 0) return 0;

    const minLength = Math.min(left.length, right.length);
    let changed = Math.abs(left.length - right.length);
    for (let i = 0; i < minLength; i++) {
      if (left[i] !== right[i]) changed++;
    }
    return changed / maxLength;
  }
}

function isUint8ArrayList(value: unknown): value is Uint8Array[] {
  return Array.isArray(value) && value.every((v) => v instanceof Uint8Array);
}
