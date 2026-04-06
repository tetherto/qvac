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
import { translationLlmTests } from "../../translation-llm-tests.js";
import { translationSalamandraTests } from "../../translation-salamandra-tests.js";
import { translationAfriquegemmaTests } from "../../translation-afriquegemma-tests.js";

interface TranslateTestParams {
  text: string;
  resource: string;
  from?: string;
  to?: string;
  context?: string;
}

const allTests = [
  ...translationMarianTests,
  ...translationIndicTransTests,
  ...translationBergamotTests,
  ...translationLlmTests,
  ...translationSalamandraTests,
  ...translationAfriquegemmaTests,
];

export class TranslationExecutor extends AbstractModelExecutor<typeof allTests> {
  pattern = /^translation-(marian|indictrans|bergamot|llm|salamandra|afriquegemma)-/;

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
      if (test.testId.endsWith("-autodetect")) {
        return [test.testId, this.autodetect.bind(this)];
      }
      if (test.testId.endsWith("-context")) {
        return [test.testId, this.withContext.bind(this)];
      }
      return [test.testId, this.generic.bind(this)];
    }),
  ) as never;

  // Presence of `to` distinguishes LLM (per-call languages) from NMT (model-level languages)
  private callTranslate(modelId: string, p: TranslateTestParams, stream: boolean) {
    if (p.to) {
      return translate({
        modelId,
        text: p.text,
        from: p.from,
        to: p.to,
        modelType: "llm",
        stream,
      });
    }
    return translate({ modelId, text: p.text, modelType: "nmt", stream });
  }

  async generic(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as TranslateTestParams;
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = this.callTranslate(modelId, p, false);
      const translatedText = await (result as { text: Promise<string> }).text;
      return ValidationHelpers.validate(translatedText, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Translation error: ${errorMsg}` };
    }
  }

  async streaming(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as TranslateTestParams;
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = this.callTranslate(modelId, p, true);
      const tokens: string[] = [];
      for await (const token of result.tokenStream) {
        tokens.push(token);
      }
      const translatedText = tokens.join("");

      if (tokens.length === 0) {
        return { passed: false, output: "Streaming produced zero tokens" };
      }

      const validation = ValidationHelpers.validate(translatedText, expectation);
      return {
        ...validation,
        output: `${validation.output} (streamed ${tokens.length} tokens)`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Translation streaming error: ${errorMsg}` };
    }
  }

  async withStats(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as TranslateTestParams;
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = this.callTranslate(modelId, p, false);
      const translatedText = await (result as { text: Promise<string> }).text;
      const stats = await result.stats;

      const textValidation = ValidationHelpers.validate(translatedText, expectation);
      if (!textValidation.passed) return textValidation;

      if (!stats) {
        return { passed: false, output: `Translation OK but stats were undefined. Text: "${translatedText}"` };
      }
      if (typeof stats.totalTokens !== "number") {
        return { passed: false, output: `Stats missing totalTokens. Got: ${JSON.stringify(stats)}` };
      }
      const hasTimingInfo = typeof stats.totalTime === "number"
        || typeof stats.timeToFirstToken === "number"
        || typeof stats.tokensPerSecond === "number";
      if (!hasTimingInfo) {
        return { passed: false, output: `Stats missing timing info. Got: ${JSON.stringify(stats)}` };
      }

      const timeLabel = stats.totalTime != null
        ? `totalTime: ${stats.totalTime}ms`
        : `ttft: ${stats.timeToFirstToken}ms, tps: ${stats.tokensPerSecond?.toFixed(1)}`;
      return {
        passed: true,
        output: `Text: "${translatedText}", tokens: ${stats.totalTokens}, ${timeLabel}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Translation stats error: ${errorMsg}` };
    }
  }

  async emptyText(params: unknown, _expectation: Expectation): Promise<TestResult> {
    const p = params as TranslateTestParams;
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = this.callTranslate(modelId, p, false);
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

  async batch(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as { texts: string[]; resource: string };
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = translate({ modelId, text: p.texts as never, modelType: "nmt", stream: false });
      const translatedText = await (result as { text: Promise<string> }).text;
      return ValidationHelpers.validate(translatedText, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Translation batch error: ${errorMsg}` };
    }
  }

  // LLM-only: translate without specifying source language (auto-detected via cld2)
  async autodetect(params: unknown, _expectation: Expectation): Promise<TestResult> {
    const p = params as TranslateTestParams;
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = translate({
        modelId,
        text: p.text,
        to: p.to!,
        modelType: "llm",
        stream: false,
      });
      const translatedText = await (result as { text: Promise<string> }).text;

      if (!translatedText || translatedText.trim().length === 0) {
        return { passed: false, output: "Autodetect translation returned empty text" };
      }

      return {
        passed: true,
        output: `Autodetected source language, translated to: "${translatedText}"`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Autodetect translation error: ${errorMsg}` };
    }
  }

  // LLM-only: translate with disambiguation context
  async withContext(params: unknown, _expectation: Expectation): Promise<TestResult> {
    const p = params as TranslateTestParams;
    const modelId = await this.resources.ensureLoaded(p.resource);

    try {
      const result = translate({
        modelId,
        text: p.text,
        from: p.from,
        to: p.to!,
        modelType: "llm",
        stream: false,
        context: p.context,
      });
      const translatedText = await (result as { text: Promise<string> }).text;

      if (!translatedText || translatedText.trim().length === 0) {
        return { passed: false, output: "Context translation returned empty text" };
      }

      return {
        passed: true,
        output: `Context translation: "${p.text}" -> "${translatedText}" (context: "${p.context}")`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Context translation error: ${errorMsg}` };
    }
  }
}
