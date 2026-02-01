// RAG executor
import { ragSaveEmbeddings } from "@qvac/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { ragTests } from "../../rag-tests.js";
import { ModelManager } from "../model-manager.js";

export class RagExecutor {
  pattern = /^rag-/;

  // All RAG tests use generic handler
  handlers = Object.fromEntries(
    ragTests.map((test) => [test.testId, this.generic]),
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
    const p = params as {
      workspace: string;
      documentContent?: string;
      documentFile?: string;
      chunkSize: number;
      chunkOverlap: number;
      chunkStrategy?: string;
    };
    const embeddingModelId = await ModelManager.getEmbeddingModel();

    try {
      // Get document content
      let content: string;
      if (p.documentFile) {
        const docPath = path.resolve(
          process.cwd(),
          "../shared-test-data/documents",
          p.documentFile,
        );
        content = fs.readFileSync(docPath, "utf-8");
      } else {
        content = p.documentContent || "";
      }

      // Save embeddings (chunks and embeds the document)
      const result = await ragSaveEmbeddings({
        modelId: embeddingModelId,
        workspace: p.workspace,
        documents: content,
        chunk: true,
        chunkOpts: {
          chunkSize: p.chunkSize,
          chunkOverlap: p.chunkOverlap,
        },
      });

      // Result is an object - just check it's truthy
      const resultStr = result ? "success" : "failed";
      return ValidationHelpers.validate(resultStr, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `RAG failed: ${errorMsg}` };
    }
  }
}
