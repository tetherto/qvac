import { loadModel, embed, GTE_LARGE_FP16 } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { shardedModelTests } from "../../sharded-model-tests.js";

export class ShardedModelExecutor extends AbstractModelExecutor<typeof shardedModelTests> {
  pattern = /^sharded-model-/;

  protected handlers = Object.fromEntries(
    shardedModelTests.map((test) => {
      if (test.testId === "sharded-model-backward-compatibility") {
        return [test.testId, this.backwardCompatibility.bind(this)];
      }
      if (test.testId === "sharded-model-batch-inference") {
        return [test.testId, this.batchInference.bind(this)];
      }
      if (test.testId === "sharded-model-inference" || test.testId === "sharded-model-long-text-inference") {
        return [test.testId, this.inference.bind(this)];
      }
      return [test.testId, this.loadSharded.bind(this)];
    }),
  ) as never;

  async loadSharded(params: unknown, expectation: unknown): Promise<TestResult> {
    const shardedModelId = await this.resources.ensureLoaded("sharded-embeddings");
    return ValidationHelpers.validate(shardedModelId, expectation as Expectation);
  }

  async backwardCompatibility(params: unknown, expectation: unknown): Promise<TestResult> {
    try {
      const modelId = await loadModel({
        modelSrc: GTE_LARGE_FP16,
        modelType: "embeddings",
      });
      await this.resources.register("embeddings", modelId);
      return ValidationHelpers.validate(modelId, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Backward compatibility failed: ${errorMsg}` };
    }
  }

  async inference(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string };
    const modelId = await this.resources.ensureLoaded("sharded-embeddings");

    try {
      const { embedding: embeddings } = await embed({ modelId, text: p.text });
      return ValidationHelpers.validate(embeddings, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Sharded inference failed: ${errorMsg}` };
    }
  }

  async batchInference(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { texts: string[] };
    const modelId = await this.resources.ensureLoaded("sharded-embeddings");

    try {
      const embeddings = [];
      for (const text of p.texts) {
        const { embedding } = await embed({ modelId, text });
        embeddings.push(embedding);
      }
      return ValidationHelpers.validate(embeddings, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Sharded batch inference failed: ${errorMsg}` };
    }
  }
}
