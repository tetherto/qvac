import { ocr } from "@qvac/sdk";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { ocrTests } from "../../ocr-tests.js";

export class OcrExecutor extends AbstractModelExecutor<typeof ocrTests> {
  pattern = /^ocr-/;

  protected handlers = Object.fromEntries(
    ocrTests.map((test) => {
      const params = test.params as { streaming?: boolean; paragraph?: boolean };
      if (params.streaming) return [test.testId, this.streaming.bind(this)];
      return [test.testId, this.generic.bind(this)];
    }),
  ) as never;

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { imageFileName: string; paragraph?: boolean };
    const ocrModelId = await this.resources.ensureLoaded("ocr");
    const imagePath = path.resolve(process.cwd(), "assets/images", p.imageFileName);

    try {
      const { blocks } = ocr({
        modelId: ocrModelId,
        image: imagePath,
        options: p.paragraph ? { paragraph: true } : undefined,
      });

      const result = await blocks;
      const allText = result.map((block) => block.text).join(" ");

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
    const imagePath = path.resolve(process.cwd(), "assets/images", p.imageFileName);

    try {
      const { blockStream } = ocr({
        modelId: ocrModelId,
        image: imagePath,
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
