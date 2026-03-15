// Generation (diffusion) executor
import { generation, type GenerationClientParams } from "@qvac/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { generationTests } from "../../generation-tests.js";
import { ModelManager } from "../model-manager.js";

export class GenerationExecutor {
  pattern = /^generation-/;

  // Most tests use the generic handler
  handlers = Object.fromEntries(
    generationTests.map((test) => [test.testId, this.generic]),
  );

  async execute(
    testId: string,
    context: unknown,
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    // Route custom tests to dedicated methods
    if (testId === "generation-seed-reproducibility") {
      return await this.seedReproducibility(params, expectation);
    }
    if (testId === "generation-streaming-progress") {
      return await this.streamingProgress(params, expectation);
    }
    if (testId === "generation-stats-present") {
      return await this.statsPresent(params, expectation);
    }

    const handler = this.handlers[testId];
    if (handler) {
      return await (
        handler as (
          params: unknown,
          expectation: unknown,
        ) => Promise<TestResult>
      ).call(this, params, expectation);
    }
    return { passed: false, output: `Unknown test: ${testId}` };
  }

  private buildParams(
    modelId: string,
    p: Record<string, unknown>,
  ): GenerationClientParams {
    const params: GenerationClientParams = {
      modelId,
      prompt: p.prompt as string,
    };

    if (p.negative_prompt != null) params.negative_prompt = p.negative_prompt as string;
    if (p.width != null) params.width = p.width as number;
    if (p.height != null) params.height = p.height as number;
    if (p.steps != null) params.steps = p.steps as number;
    if (p.cfg_scale != null) params.cfg_scale = p.cfg_scale as number;
    if (p.guidance != null) params.guidance = p.guidance as number;
    if (p.sampling_method != null) params.sampling_method = p.sampling_method as GenerationClientParams["sampling_method"];
    if (p.scheduler != null) params.scheduler = p.scheduler as GenerationClientParams["scheduler"];
    if (p.seed != null) params.seed = p.seed as number;
    if (p.batch_count != null) params.batch_count = p.batch_count as number;
    if (p.vae_tiling != null) params.vae_tiling = p.vae_tiling as boolean;
    if (p.stream != null) params.stream = p.stream as boolean;

    if (p.initImageFileName) {
      const imagePath = path.resolve(
        process.cwd(),
        "../shared-test-data/images",
        p.initImageFileName as string,
      );
      params.init_image = fs.readFileSync(imagePath);
      params.strength = (p.strength as number) ?? 0.75;
    }

    return params;
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as Record<string, unknown>;
    const modelId = await ModelManager.getDiffusionModel();

    try {
      const genParams = this.buildParams(modelId, p);

      if (genParams.stream) {
        const { outputStream } = generation(genParams);
        const collected: string[] = [];
        for await (const { data } of outputStream) {
          collected.push(data);
        }
        return ValidationHelpers.validate(
          collected,
          expectation as Expectation,
        );
      }

      const { outputs } = generation(genParams);
      const buffers = await outputs;
      return ValidationHelpers.validate(buffers, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const exp = expectation as Expectation;
      if (exp.validation === "throws-error") {
        return ValidationHelpers.validate(errorMsg, exp);
      }
      return { passed: false, output: `Generation failed: ${errorMsg}` };
    }
  }

  async seedReproducibility(
    params: unknown,
    _expectation: unknown,
  ): Promise<TestResult> {
    const p = params as Record<string, unknown>;
    const modelId = await ModelManager.getDiffusionModel();

    try {
      const genParams = this.buildParams(modelId, p);
      delete genParams.stream;

      const { outputs: outputs1 } = generation(genParams);
      const buffers1 = await outputs1;

      const { outputs: outputs2 } = generation(genParams);
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
    const modelId = await ModelManager.getDiffusionModel();

    try {
      const genParams = this.buildParams(modelId, { ...p, stream: true });
      const { outputStream, stats } = generation(genParams);

      let outputCount = 0;
      for await (const _chunk of outputStream) {
        outputCount++;
      }

      const finalStats = await stats;
      const hasOutputs = outputCount > 0;
      const hasStats = finalStats != null;

      return {
        passed: hasOutputs && hasStats,
        output: `Received ${outputCount} output(s), stats: ${hasStats ? "present" : "missing"}`,
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
    const modelId = await ModelManager.getDiffusionModel();

    try {
      const genParams = this.buildParams(modelId, p);
      const { outputs, stats } = generation(genParams);

      await outputs;
      const finalStats = await stats;

      if (!finalStats) {
        return { passed: false, output: "Stats missing from response" };
      }

      const hasExpectedFields =
        typeof finalStats.steps === "number" ||
        typeof finalStats.generation_time === "number" ||
        typeof finalStats.totalSteps === "number";

      return {
        passed: hasExpectedFields,
        output: `Stats present: ${JSON.stringify(finalStats)}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Stats test failed: ${errorMsg}` };
    }
  }
}
