import { ragIngest } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import { ragTests } from "../../rag-tests.js";

export class MobileRagExecutor extends ModelAssetExecutor<typeof ragTests> {
  pattern = /^rag-/;

  protected handlers = Object.fromEntries(
    ragTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;
  protected defaultHandler = undefined;

  private documentAssets: Record<string, number> | null = null;

  constructor(resources: ResourceManager) {
    super(resources);
  }

  private async loadDocumentAssets() {
    if (!this.documentAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import("../../../../assets");
      this.documentAssets = assets.documents;
    }
    return this.documentAssets!;
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
    const exp = expectation as Expectation;
    const embeddingModelId = await this.resources.ensureLoaded("embeddings");

    try {
      let content: string;
      if (p.documentFile) {
        const documents = await this.loadDocumentAssets();
        const assetModule = documents[p.documentFile];
        if (!assetModule) {
          return { passed: false, output: `Document file not found: ${p.documentFile}` };
        }
        const docUri = await this.resolveAsset(assetModule);
        // @ts-ignore - expo-file-system is a peer dependency available in mobile context
        const { File } = await import("expo-file-system");
        content = await new File(`file://${docUri}`).text();
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
