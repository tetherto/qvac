import { embed } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { embeddingTests } from "../../embedding-tests.js";

export class EmbeddingExecutor extends AbstractModelExecutor<
  typeof embeddingTests
> {
  pattern = /^embed-/;

  protected handlers = Object.fromEntries(
    embeddingTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text?: string; texts?: string[] };
    const embeddingModelId = await this.resources.ensureLoaded("embeddings");

    try {
      if (p.texts) {
        const embeddings = [];
        for (const text of p.texts) {
          const { embedding } = await embed({ modelId: embeddingModelId, text });
          embeddings.push(embedding);
        }
        return ValidationHelpers.validate(
          embeddings,
          expectation as Expectation,
        );
      }

      const text = p.text || "";
      const { embedding } = await embed({ modelId: embeddingModelId, text });
      return ValidationHelpers.validate(embedding, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Embedding failed: ${errorMsg}` };
    }
  }
}
