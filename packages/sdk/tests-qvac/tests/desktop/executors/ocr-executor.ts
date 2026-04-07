import { ocr, type OCRTextBlock } from "@qvac/sdk";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { ocrTests } from "../../ocr-tests.js";

interface OcrParams {
  imageFileName: string;
  paragraph?: boolean;
  streaming?: boolean;
}

export class OcrExecutor extends AbstractModelExecutor<typeof ocrTests> {
  pattern = /^ocr-/;

  protected handlers = Object.fromEntries(
    ocrTests.map((test) => {
      if (test.testId.endsWith("-stats")) return [test.testId, this.withStats.bind(this)];
      if (test.testId.endsWith("-block-structure")) return [test.testId, this.blockStructure.bind(this)];
      return [test.testId, this.generic.bind(this)];
    }),
  ) as never;

  private async runOcr(p: OcrParams) {
    const ocrModelId = await this.resources.ensureLoaded("ocr");
    const imagePath = path.resolve(process.cwd(), "assets/images", p.imageFileName);

    const { blocks, blockStream, stats } = ocr({
      modelId: ocrModelId,
      image: imagePath,
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
