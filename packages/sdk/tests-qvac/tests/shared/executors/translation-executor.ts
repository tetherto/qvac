import { translate } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { translationTests } from "../../translation-tests.js";

export class TranslationExecutor extends AbstractModelExecutor<
  typeof translationTests
> {
  pattern = /^translation-/;

  protected handlers = Object.fromEntries(
    translationTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      text: string;
      sourceLang: string;
      targetLang: string;
    };
    const llmModelId = await this.resources.ensureLoaded("llm");

    try {
      const result = translate({
        modelId: llmModelId,
        modelType: "llm",
        text: p.text,
        from: p.sourceLang,
        to: p.targetLang,
        stream: false,
      });

      const translatedText =
        typeof result === "string" ? result : await result.text;
      return ValidationHelpers.validate(
        translatedText,
        expectation as Expectation,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Translation failed: ${errorMsg}` };
    }
  }
}
