// Translation executor
import { translate } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { translationTests } from "../../translation-tests.js";
import { ModelManager } from "../model-manager.js";

export class TranslationExecutor {
  pattern = /^translation-/;

  // All translation tests use generic handler
  handlers = Object.fromEntries(
    translationTests.map((test) => [test.testId, this.generic]),
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
      text: string;
      sourceLang: string;
      targetLang: string;
    };
    const llmModelId = await ModelManager.getLlmModel();

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
