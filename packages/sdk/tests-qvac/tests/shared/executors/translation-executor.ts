import { translate } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { translationMarianTests } from "../../translation-marian-tests.js";
import { translationIndicTransTests } from "../../translation-indictrans-tests.js";
import { translationBergamotTests } from "../../translation-bergamot-tests.js";

const allTests = [
  ...translationMarianTests,
  ...translationIndicTransTests,
  ...translationBergamotTests,
];

export class TranslationExecutor extends AbstractModelExecutor<typeof allTests> {
  pattern = /^translation-(marian|indictrans|bergamot)-/;

  protected handlers = Object.fromEntries(
    allTests.map((test) => {
      if (test.testId.endsWith("-empty-text")) {
        return [test.testId, this.emptyText.bind(this)];
      }
      if (test.testId.endsWith("-streaming")) {
        return [test.testId, this.streaming.bind(this)];
      }
      if (test.testId.endsWith("-stats")) {
        return [test.testId, this.withStats.bind(this)];
      }
      if (test.testId.includes("-batch-")) {
        return [test.testId, this.batch.bind(this)];
      }
      return [test.testId, this.generic.bind(this)];
    }),
  ) as never;

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string; resource: string };
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = translate({ modelId, text: p.text, modelType: "nmt", stream: false });
      const translatedText = await (result as { text: Promise<string> }).text;
      return ValidationHelpers.validate(translatedText, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Translation error: ${errorMsg}` };
    }
  }

  async streaming(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string; resource: string };
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = translate({ modelId, text: p.text, modelType: "nmt", stream: true });
      const tokens: string[] = [];
      for await (const token of result.tokenStream) {
        tokens.push(token);
      }
      const translatedText = tokens.join("");

      if (tokens.length === 0) {
        return { passed: false, output: "Streaming produced zero tokens" };
      }

      const validation = ValidationHelpers.validate(translatedText, expectation as Expectation);
      return {
        ...validation,
        output: `${validation.output} (streamed ${tokens.length} tokens)`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Translation streaming error: ${errorMsg}` };
    }
  }

  async withStats(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string; resource: string };
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = translate({ modelId, text: p.text, modelType: "nmt", stream: false });
      const translatedText = await (result as { text: Promise<string> }).text;
      const stats = await result.stats;

      const textValidation = ValidationHelpers.validate(translatedText, expectation as Expectation);
      if (!textValidation.passed) return textValidation;

      if (!stats) {
        return { passed: false, output: `Translation OK but stats were undefined. Text: "${translatedText}"` };
      }
      if (typeof stats.processedTokens !== "number" || typeof stats.processingTime !== "number") {
        return { passed: false, output: `Stats missing fields. Got: ${JSON.stringify(stats)}` };
      }

      return {
        passed: true,
        output: `Text: "${translatedText}", tokens: ${stats.processedTokens}, time: ${stats.processingTime}ms`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Translation stats error: ${errorMsg}` };
    }
  }

  async emptyText(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string; resource: string };
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = translate({ modelId, text: p.text, modelType: "nmt", stream: false });
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
    const p = params as { texts: string[]; resource: string };
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = translate({ modelId, text: p.texts as never, modelType: "nmt", stream: false });
      const translatedText = await (result as { text: Promise<string> }).text;
      return ValidationHelpers.validate(translatedText, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Translation batch error: ${errorMsg}` };
    }
  }
}
