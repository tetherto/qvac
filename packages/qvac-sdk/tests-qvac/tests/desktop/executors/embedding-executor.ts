// Embedding executor
import { embed } from "@qvac/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { embeddingTests } from "../../embedding-tests.js";
import { ModelManager } from "../model-manager.js";

export class EmbeddingExecutor {
  pattern = /^embed-/;

  // All embedding tests use generic handler
  handlers = Object.fromEntries(
    embeddingTests.map((test) => [test.testId, this.generic]),
  );

  async execute(
    testId: string,
    context: unknown,
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
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

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text?: string; codeFile?: string; texts?: string[] };
    const embeddingModelId = await ModelManager.getEmbeddingModel();

    try {
      // Handle batch embedding
      if (p.texts) {
        const embeddings = [];
        for (const text of p.texts) {
          const embedding = await embed({ modelId: embeddingModelId, text });
          embeddings.push(embedding);
        }
        return ValidationHelpers.validate(
          embeddings,
          expectation as Expectation,
        );
      }

      // Handle code file embedding
      if (p.codeFile) {
        const codePath = path.resolve(
          process.cwd(),
          "../shared-test-data/code",
          p.codeFile,
        );
        const code = fs.readFileSync(codePath, "utf-8");
        const embedding = await embed({
          modelId: embeddingModelId,
          text: code,
        });
        return ValidationHelpers.validate(
          embedding,
          expectation as Expectation,
        );
      }

      // Handle text embedding
      const text = p.text || "";
      const embedding = await embed({ modelId: embeddingModelId, text });
      return ValidationHelpers.validate(embedding, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Embedding failed: ${errorMsg}` };
    }
  }
}
