import { ocr } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import { ocrTests } from "../../ocr-tests.js";

export class MobileOcrExecutor extends ModelAssetExecutor<typeof ocrTests> {
  pattern = /^ocr-/;

  protected handlers = Object.fromEntries(
    ocrTests.map((test) => {
      const params = test.params as { streaming?: boolean };
      if (params.streaming) return [test.testId, this.streaming.bind(this)];
      return [test.testId, this.generic.bind(this)];
    }),
  ) as never;
  protected defaultHandler = undefined;

  private imageAssets: Record<string, number> | null = null;

  constructor(resources: ResourceManager) {
    super(resources);
  }

  private async loadImageAssets() {
    if (!this.imageAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import("../../../../assets");
      this.imageAssets = assets.images;
    }
    return this.imageAssets!;
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { imageFileName: string; paragraph?: boolean };
    const ocrModelId = await this.resources.ensureLoaded("ocr");

    const images = await this.loadImageAssets();
    const assetModule = images[p.imageFileName];
    if (!assetModule) {
      return { passed: false, output: `Image file not found: ${p.imageFileName}` };
    }

    try {
      const imageUri = await this.resolveAsset(assetModule);
      const { blocks } = ocr({
        modelId: ocrModelId,
        image: imageUri,
        options: p.paragraph ? { paragraph: true } : undefined,
      });

      const result = await blocks;
      const allText = result.map((block: { text: string }) => block.text).join(" ");

      const exp = expectation as Expectation;
      if (exp.validation === "contains-all" || exp.validation === "contains-any") {
        return ValidationHelpers.validate(allText, exp);
      }
      return ValidationHelpers.validate(result, exp);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `OCR failed: ${errorMsg}` };
    }
  }

  async streaming(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { imageFileName: string };
    const ocrModelId = await this.resources.ensureLoaded("ocr");

    const images = await this.loadImageAssets();
    const assetModule = images[p.imageFileName];
    if (!assetModule) {
      return { passed: false, output: `Image file not found: ${p.imageFileName}` };
    }

    try {
      const imageUri = await this.resolveAsset(assetModule);
      const { blockStream } = ocr({
        modelId: ocrModelId,
        image: imageUri,
        stream: true,
      });

      const allBlocks: Array<{ text: string }> = [];
      for await (const blocks of blockStream) {
        allBlocks.push(...blocks);
      }

      const allText = allBlocks.map((b) => b.text).join(" ");
      const exp = expectation as Expectation;
      if (exp.validation === "contains-all" || exp.validation === "contains-any") {
        return ValidationHelpers.validate(allText, exp);
      }
      return ValidationHelpers.validate(allBlocks, exp);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `OCR streaming failed: ${errorMsg}` };
    }
  }
}
