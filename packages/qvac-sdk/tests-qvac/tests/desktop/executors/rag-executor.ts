import { ragIngest } from "@qvac/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { ragTests } from "../../rag-tests.js";

export class RagExecutor extends AbstractModelExecutor<typeof ragTests> {
  pattern = /^rag-/;

  protected handlers = Object.fromEntries(
    ragTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      workspace: string;
      documentContent?: string;
      documentFile?: string;
      chunkSize: number;
      chunkOverlap: number;
      chunkStrategy?: string;
    };
    const embeddingModelId = await this.resources.ensureLoaded("embeddings");

    try {
      let content: string;
      if (p.documentFile) {
        const docPath = path.resolve(
          process.cwd(),
          "assets/documents",
          p.documentFile,
        );
        content = fs.readFileSync(docPath, "utf-8");
      } else {
        content = p.documentContent || "";
      }

      const result = await ragIngest({
        modelId: embeddingModelId,
        workspace: p.workspace,
        documents: content,
        chunk: true,
        chunkOpts: {
          chunkSize: p.chunkSize,
          chunkOverlap: p.chunkOverlap,
        },
      });

      const resultStr = result.processed.length > 0 ? "success" : "failed";
      return ValidationHelpers.validate(resultStr, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `RAG failed: ${errorMsg}` };
    }
  }
}
