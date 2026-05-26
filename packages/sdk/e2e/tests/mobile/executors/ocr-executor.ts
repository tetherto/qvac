import { ocr, type OCRTextBlock } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import { ocrTests } from "../../ocr-tests.js";

interface OcrParams {
  imageFileName: string;
  paragraph?: boolean;
  streaming?: boolean;
}

export class MobileOcrExecutor extends ModelAssetExecutor<typeof ocrTests> {
  pattern = /^ocr-/;

  protected handlers = Object.fromEntries(
    ocrTests.map((test) => {
      if (test.testId.endsWith("-stats")) return [test.testId, this.withStats.bind(this)];
      if (test.testId.endsWith("-block-structure")) return [test.testId, this.blockStructure.bind(this)];
      return [test.testId, this.generic.bind(this)];
    }),
  ) as never;
  protected defaultHandler = undefined;

  private imageAssets: Record<string, number> | null = null;

  constructor(resources: ResourceManager) {
    super(resources);
  }

  /**
   * Force-evict OCR after every test. Unlike llama.cpp/whisper, ONNX Runtime
   * with CoreML does not release compiled-model buffers between inference
   * calls on the same session. Keeping the session alive across 12+ tests
   * causes native memory to accumulate well past 2 GB, triggering iOS
   * jetsam (OOM kill). Evicting here tears down the native session so the
   * next ensureLoaded creates a fresh one with a clean allocation slate.
   *
   * Standard evictStale(5) never fires because OCR is "used" every test;
   * evictExcept in setup also keeps OCR loaded (it IS the current dep).
   * This explicit evict is the only path that actually unloads between tests.
   */
  override async teardown(testId: string, context: unknown): Promise<void> {
    await super.teardown(testId, context);
    await this.resources.evict("ocr");
  }

  private async loadImageAssets() {
    if (!this.imageAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import("../../../../assets");
      this.imageAssets = assets.images;
    }
    return this.imageAssets!;
  }

  private async runOcr(p: OcrParams) {
    const ocrModelId = await this.resources.ensureLoaded("ocr");

    const images = await this.loadImageAssets();
    const assetModule = images[p.imageFileName];
    if (!assetModule) throw new Error(`Image file not found: ${p.imageFileName}`);
    const imageUri = await this.resolveAsset(assetModule);

    const { blocks, blockStream, stats } = ocr({
      modelId: ocrModelId,
      image: imageUri,
      stream: p.streaming ?? false,
      options: p.paragraph ? { paragraph: true } : undefined,
    });

    let resultBlocks: OCRTextBlock[];
    if (p.streaming) {
      resultBlocks = [];
      for await (const batch of blockStream) resultBlocks.push(...batch);
    } else {
      resultBlocks = await blocks;
    }

    return { blocks: resultBlocks, stats };
  }

  private validateExpectation(blocks: OCRTextBlock[], expectation: Expectation): TestResult {
    const allText = blocks.map((b) => b.text).join(" ");
    if (expectation.validation === "contains-all" || expectation.validation === "contains-any") {
      return ValidationHelpers.validate(allText, expectation);
    }
    return ValidationHelpers.validate(blocks, expectation);
  }

  private checkStats(stats: { detectionTime?: number; recognitionTime?: number; totalTime?: number } | undefined): TestResult | null {
    if (!stats) return { passed: false, output: "stats is undefined, expected timing data" };
    if (typeof stats.totalTime !== "number" || stats.totalTime <= 0) {
      return { passed: false, output: `Expected stats.totalTime > 0, got: ${JSON.stringify(stats)}` };
    }
    return null;
  }

  private checkBlockStructure(blocks: OCRTextBlock[]): TestResult | null {
    for (const [i, block] of blocks.entries()) {
      if (typeof block.text !== "string") {
        return { passed: false, output: `Block[${i}].text is not a string: ${JSON.stringify(block)}` };
      }
      if (!block.bbox || !Array.isArray(block.bbox) || block.bbox.length !== 4) {
        return { passed: false, output: `Block[${i}].bbox is not a 4-element array: ${JSON.stringify(block)}` };
      }
      const badCoord = block.bbox.findIndex((x) => typeof x !== "number");
      if (badCoord !== -1) {
        return { passed: false, output: `Block[${i}].bbox[${badCoord}] is not a number: ${block.bbox[badCoord]}` };
      }
      if (typeof block.confidence !== "number") {
        return { passed: false, output: `Block[${i}].confidence is not a number: ${JSON.stringify(block)}` };
      }
      if (block.confidence < 0 || block.confidence > 1) {
        return { passed: false, output: `Block[${i}].confidence out of range [0,1]: ${block.confidence}` };
      }
    }
    return null;
  }

  async generic(params: OcrParams, expectation: Expectation): Promise<TestResult> {
    try {
      const { blocks } = await this.runOcr(params);
      return this.validateExpectation(blocks, expectation);
    } catch (error) {
      return { passed: false, output: `OCR failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async withStats(params: OcrParams, expectation: Expectation): Promise<TestResult> {
    try {
      const { blocks, stats } = await this.runOcr(params);
      const err = this.checkStats(await stats);
      if (err) return err;
      return this.validateExpectation(blocks, expectation);
    } catch (error) {
      return { passed: false, output: `OCR stats failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async blockStructure(params: OcrParams, expectation: Expectation): Promise<TestResult> {
    try {
      const { blocks } = await this.runOcr(params);
      const err = this.checkBlockStructure(blocks);
      if (err) return err;
      return this.validateExpectation(blocks, expectation);
    } catch (error) {
      return { passed: false, output: `OCR block-structure failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

}
