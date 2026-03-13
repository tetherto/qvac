import { translate } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { nmtTests } from "../../nmt-tests.js";

export class NmtExecutor extends AbstractModelExecutor<typeof nmtTests> {
  pattern = /^nmt-/;

  protected handlers = Object.fromEntries(
    nmtTests.map((test) => {
      if (test.testId === "nmt-translation-empty-text") {
        return [test.testId, this.emptyText.bind(this)];
      }
      if (test.testId.startsWith("nmt-batch-")) {
        return [test.testId, this.batch.bind(this)];
      }
      return [test.testId, this.generic.bind(this)];
    }),
  ) as never;

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string };
    const nmtModelId = await this.resources.ensureLoaded("nmt");

    try {
      const result = translate({
        modelId: nmtModelId,
        text: p.text,
        modelType: "nmt",
        stream: false,
      });
      const translatedText = await (result as { text: Promise<string> }).text;

      return ValidationHelpers.validate(translatedText, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `NMT error: ${errorMsg}` };
    }
  }

  async emptyText(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string };
    const nmtModelId = await this.resources.ensureLoaded("nmt");

    try {
      const result = translate({
        modelId: nmtModelId,
        text: p.text,
        modelType: "nmt",
        stream: false,
      });
      const translatedText = await (result as { text: Promise<string> }).text;
      const isEmpty = !translatedText || translatedText.trim().length === 0;
      return {
        passed: isEmpty,
        output: `Empty text handled: result="${translatedText || "(empty)"}"`,
      };
    } catch (error) {
      return { passed: true, output: `Empty text correctly rejected: ${error}` };
    }
  }

  async batch(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { texts: string[] };
    const nmtModelId = await this.resources.ensureLoaded("nmt");

    try {
      const result = translate({
        modelId: nmtModelId,
        text: p.texts as never,
        modelType: "nmt",
        stream: false,
      });
      const translatedText = await (result as { text: Promise<string> }).text;

      return ValidationHelpers.validate(translatedText, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Batch NMT error: ${errorMsg}` };
    }
  }
}
