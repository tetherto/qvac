import { loadModel, embed, unloadModel } from "@qvac/sdk";
import {
  AssetExecutor,
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { httpEmbeddingTests } from "../../http-embedding-tests.js";

/**
 * Mobile-specific HTTP embedding executor that aggressively evicts
 * all ResourceManager models before loading HTTP models (to avoid OOM),
 * and explicitly unloads HTTP-loaded models after each test.
 */
export class MobileHttpEmbeddingExecutor extends AssetExecutor<typeof httpEmbeddingTests> {
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
  protected defaultHandler = undefined;

  private lastLoadedModelId: string | null = null;

  constructor(private resources: ResourceManager) {
    super();
  }

  async setup(testId: string, _context: unknown) {
    await this.resources.evictAll();
  }

  async teardown() {
    if (this.lastLoadedModelId) {
      try {
        await unloadModel({ modelId: this.lastLoadedModelId });
      } catch (_) { /* ignore */ }
      this.lastLoadedModelId = null;
    }
    await this.resources.evictAll();
  }

  async load(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelUrl: string; modelType: string };

    try {
      const modelId = await loadModel({
        modelSrc: p.modelUrl,
        modelType: p.modelType as "embeddings",
      });
      this.lastLoadedModelId = modelId;
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
      this.lastLoadedModelId = modelId;
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
      this.lastLoadedModelId = modelId;

      const embeddings = await embed({ modelId, text: p.text });
      return ValidationHelpers.validate(embeddings, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `HTTP embed inference failed: ${errorMsg}` };
    }
  }
}
