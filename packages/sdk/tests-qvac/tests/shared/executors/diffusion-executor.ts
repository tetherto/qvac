// Diffusion executor
import { diffusion, type DiffusionClientParams } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { diffusionTests } from "../../diffusion-tests.js";

// Minimum byte-level divergence between fusion output and the same-seed txt2img
// baseline. SDK output is bit-exact at fixed seed (see seedReproducibility), so
// 1% is well above noise and catches a silent fallback when init_images is dropped.
const MIN_FUSION_DIVERGENCE_RATIO = 0.01;

export class DiffusionExecutor extends AbstractModelExecutor<typeof diffusionTests> {
  pattern = /^diffusion-/;

  protected handlers = Object.fromEntries(
    diffusionTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  async execute(
    testId: string,
    context: unknown,
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    if (testId === "diffusion-seed-reproducibility") {
      return await this.seedReproducibility(params, expectation);
    }
    if (testId === "diffusion-streaming-progress") {
      return await this.streamingProgress(params, expectation);
    }
    if (testId === "diffusion-stats-present") {
      return await this.statsPresent(params, expectation);
    }
    if (testId === "diffusion-fusion-flux2-basic") {
      return await this.fusionFlux2Basic(params, expectation);
    }

    const handler = (this.handlers as Record<string, (params: unknown, expectation: unknown) => Promise<TestResult>>)[testId];
    if (handler) {
      return await handler.call(this, params, expectation);
    }
    return { passed: false, output: `Unknown test: ${testId}` };
  }

  // mobile and desktop subclasses override this to handle filesystem differences
  protected async resolveParams(p: Record<string, unknown>): Promise<Record<string, unknown>> {
    return p;
  }

  protected buildParams(
    modelId: string,
    p: Record<string, unknown>,
  ): DiffusionClientParams {
    const params: Omit<DiffusionClientParams, "init_image" | "init_images"> = {
      modelId,
      prompt: p.prompt as string,
    };

    if (p.negative_prompt != null) params.negative_prompt = p.negative_prompt as string;
    if (p.width != null) params.width = p.width as number;
    if (p.height != null) params.height = p.height as number;
    if (p.steps != null) params.steps = p.steps as number;
    if (p.cfg_scale != null) params.cfg_scale = p.cfg_scale as number;
    if (p.guidance != null) params.guidance = p.guidance as number;
    if (p.sampling_method != null) params.sampling_method = p.sampling_method as DiffusionClientParams["sampling_method"];
    if (p.scheduler != null) params.scheduler = p.scheduler as DiffusionClientParams["scheduler"];
    if (p.seed != null) params.seed = p.seed as number;
    if (p.batch_count != null) params.batch_count = p.batch_count as number;
    if (p.vae_tiling != null) params.vae_tiling = p.vae_tiling as boolean;
    if (p.increase_ref_index != null) params.increase_ref_index = p.increase_ref_index as boolean;
    if (p.auto_resize_ref_image != null) params.auto_resize_ref_image = p.auto_resize_ref_image as boolean;
    if (p.lora != null) params.lora = p.lora as string;
    if (p.strength != null) params.strength = p.strength as number;

    if (p.init_image != null && p.init_images != null) {
      throw new Error(
        "Test params cannot set both init_image and init_images (mutually exclusive).",
      );
    }

    if (p.init_images != null) {
      return { ...params, init_images: p.init_images as Uint8Array[] };
    }
    if (p.init_image != null) {
      return { ...params, init_image: p.init_image as Uint8Array };
    }
    return params;
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = await this.resolveParams(params as Record<string, unknown>);
    const modelId = await this.resources.ensureLoaded("diffusion");

    try {
      const genParams = this.buildParams(modelId, p);
      const { outputs } = diffusion(genParams);
      const buffers = await outputs;
      return ValidationHelpers.validate(buffers, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const exp = expectation as Expectation;
      if (exp.validation === "throws-error") {
        return ValidationHelpers.validate(errorMsg, exp);
      }
      return { passed: false, output: `Diffusion failed: ${errorMsg}` };
    }
  }

  async seedReproducibility(
    params: unknown,
    _expectation: unknown,
  ): Promise<TestResult> {
    const p = params as Record<string, unknown>;
    const modelId = await this.resources.ensureLoaded("diffusion");

    try {
      const genParams = this.buildParams(modelId, p);

      const { outputs: outputs1 } = diffusion(genParams);
      const buffers1 = await outputs1;

      const { outputs: outputs2 } = diffusion(genParams);
      const buffers2 = await outputs2;

      if (buffers1.length === 0 || buffers2.length === 0) {
        return { passed: false, output: "No outputs generated" };
      }

      const match =
        buffers1[0]!.length === buffers2[0]!.length &&
        buffers1[0]!.every((byte: number, i: number) => byte === buffers2[0]![i]);

      return {
        passed: match,
        output: match
          ? "Same seed produces identical output"
          : `Outputs differ: ${buffers1[0]!.length} vs ${buffers2[0]!.length} bytes`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        passed: false,
        output: `Seed reproducibility failed: ${errorMsg}`,
      };
    }
  }

  async streamingProgress(
    params: unknown,
    _expectation: unknown,
  ): Promise<TestResult> {
    const p = params as Record<string, unknown>;
    const modelId = await this.resources.ensureLoaded("diffusion");

    try {
      const genParams = this.buildParams(modelId, p);
      const { progressStream, outputs, stats } = diffusion(genParams);

      const progressTicks: { step: number; totalSteps: number; elapsedMs: number }[] = [];
      for await (const tick of progressStream) {
        progressTicks.push(tick);
      }

      const buffers = await outputs;
      const finalStats = await stats;

      const hasOutputs = buffers.length > 0;
      const hasStats = finalStats != null;
      const hasProgress = progressTicks.length > 0;
      const progressValid = progressTicks.every(
        (t) => typeof t.step === "number" && typeof t.totalSteps === "number" && typeof t.elapsedMs === "number",
      );

      return {
        passed: hasOutputs && hasStats && hasProgress && progressValid,
        output: `Received ${buffers.length} output(s), ${progressTicks.length} progress tick(s), stats: ${hasStats ? "present" : "missing"}, progress valid: ${progressValid}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        passed: false,
        output: `Streaming progress failed: ${errorMsg}`,
      };
    }
  }

  async statsPresent(
    params: unknown,
    _expectation: unknown,
  ): Promise<TestResult> {
    const p = params as Record<string, unknown>;
    const modelId = await this.resources.ensureLoaded("diffusion");

    try {
      const genParams = this.buildParams(modelId, p);
      const { outputs, stats } = diffusion(genParams);

      await outputs;
      const finalStats = await stats;

      if (!finalStats) {
        return { passed: false, output: "Stats missing from response" };
      }

      const hasExpectedFields =
        typeof finalStats.totalSteps === "number" ||
        typeof finalStats.generationMs === "number" ||
        typeof finalStats.modelLoadMs === "number";

      return {
        passed: hasExpectedFields,
        output: `Stats present: ${JSON.stringify(finalStats)}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Stats test failed: ${errorMsg}` };
    }
  }

  // Compare fusion vs same-seed/prompt baseline with init_images dropped.
  // If the addon silently ignores init_images, byte delta collapses and this fails.
  async fusionFlux2Basic(
    params: unknown,
    _expectation: unknown,
  ): Promise<TestResult> {
    const p = await this.resolveParams(params as Record<string, unknown>);
    const modelId = await this.resources.ensureLoaded("diffusion");

    if (p.seed === undefined) {
      return {
        passed: false,
        output: "fusion test requires a fixed seed to compare against baseline",
      };
    }

    try {
      const fusionParams = this.buildParams(modelId, p);
      const baselineParams = this.buildParams(modelId, {
        ...p,
        init_images: undefined,
      });

      const { outputs: fusionOutputs } = diffusion(fusionParams);
      const fusionBuffers = await fusionOutputs;

      const { outputs: baselineOutputs } = diffusion(baselineParams);
      const baselineBuffers = await baselineOutputs;

      if (fusionBuffers.length === 0 || baselineBuffers.length === 0) {
        return {
          passed: false,
          output: `Missing output(s): fusion=${fusionBuffers.length}, baseline=${baselineBuffers.length}`,
        };
      }

      const diffRatio = this.byteDiffRatio(
        fusionBuffers[0]!,
        baselineBuffers[0]!,
      );
      const passed = diffRatio > MIN_FUSION_DIVERGENCE_RATIO;
      const deltaPct = (diffRatio * 100).toFixed(2);

      return {
        passed,
        output: passed
          ? `Fusion output differs from txt2img baseline (${deltaPct}% byte delta)`
          : `Fusion output matches txt2img baseline too closely (${deltaPct}% byte delta)`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        passed: false,
        output: `FLUX.2 fusion comparison failed: ${errorMsg}`,
      };
    }
  }

  private byteDiffRatio(left: Uint8Array, right: Uint8Array): number {
    const maxLength = Math.max(left.length, right.length);
    if (maxLength === 0) {
      return 0;
    }

    const minLength = Math.min(left.length, right.length);
    let changed = Math.abs(left.length - right.length);

    for (let i = 0; i < minLength; i++) {
      if (left[i] !== right[i]) {
        changed++;
      }
    }

    return changed / maxLength;
  }
}
