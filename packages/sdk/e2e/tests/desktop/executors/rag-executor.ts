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
    const exp = expectation as Expectation;
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

      const uniqueWorkspace = `${p.workspace}-${embeddingModelId.substring(0, 8)}`;

      const result = await ragIngest({
        modelId: embeddingModelId,
        workspace: uniqueWorkspace,
        documents: [content] as never,
        chunk: true,
        chunkOpts: {
          chunkSize: p.chunkSize,
          chunkOverlap: p.chunkOverlap,
          ...(p.chunkStrategy ? { chunkStrategy: p.chunkStrategy as "paragraph" | "character" } : {}),
        },
      });

      if (exp.validation === "throws-error") {
        return { passed: false, output: "Expected error but RAG succeeded" };
      }
      const resultStr = result.processed.length > 0 ? "success" : "failed";
      return ValidationHelpers.validate(resultStr, exp);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (exp.validation === "throws-error") {
        return ValidationHelpers.validate(errorMsg, exp);
      }
      return { passed: false, output: `RAG failed: ${errorMsg}` };
    }
  }
}
