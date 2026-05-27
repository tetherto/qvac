import { loadModel, embed } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { httpEmbeddingTests } from "../../http-embedding-tests.js";

export class HttpEmbeddingExecutor extends AbstractModelExecutor<typeof httpEmbeddingTests> {
  pattern = /^http-/;

  protected handlers = Object.fromEntries(
    httpEmbeddingTests.map((test) => {
      if (test.testId.endsWith("-progress")) {
        return [test.testId, this.progress.bind(this)];
      }
      if (test.testId.endsWith("-inference")) {
        return [test.testId, this.inference.bind(this)];
      }
      return [test.testId, this.load.bind(this)];
    }),
  ) as never;

  async setup(testId: string, context: unknown) {
    await super.setup(testId, context);
    await this.resources.evictAll();
  }

  async load(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelUrl: string; modelType: string };

    try {
      const modelId = await loadModel({
        modelSrc: p.modelUrl,
        modelType: p.modelType as "embeddings",
      });
      this.resources.register("embeddings", modelId);
      return ValidationHelpers.validate(modelId, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `HTTP embed load failed: ${errorMsg}` };
    }
  }

  async progress(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelUrl: string; modelType: string };
    const progressEvents: unknown[] = [];

    try {
      const modelId = await loadModel({
        modelSrc: p.modelUrl,
        modelType: p.modelType as "embeddings",
        onProgress: (progress: unknown) => {
          progressEvents.push(progress);
        },
      });
      this.resources.register("embeddings", modelId);
      return ValidationHelpers.validate(modelId, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `HTTP embed progress failed: ${errorMsg}` };
    }
  }

  async inference(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelUrl: string; modelType: string; text: string };

    try {
      const modelId = await loadModel({
        modelSrc: p.modelUrl,
        modelType: p.modelType as "embeddings",
      });
      this.resources.register("embeddings", modelId);
      const { embedding: embeddings } = await embed({ modelId, text: p.text });
      return ValidationHelpers.validate(embeddings, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `HTTP embed inference failed: ${errorMsg}` };
    }
  }
}
