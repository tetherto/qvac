// Completion executor
import { completion } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { completionTests } from "../../completion-tests.js";
import { ModelManager } from "../model-manager.js";

export class CompletionExecutor {
  pattern = /^completion-/;

  // Build handlers map dynamically from all completion tests
  handlers = Object.fromEntries(
    completionTests.map((test) => [test.testId, this.generic]),
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

  private async runCompletion(params: {
    history: Array<{ role: string; content: string }>;
    stream?: boolean;
    [key: string]: unknown;
  }): Promise<string> {
    const llmModelId = await ModelManager.getLlmModel();

    const { history, stream, ...otherParams } = params;
    const result = completion({
      modelId: llmModelId,
      history,
      stream: stream ?? false,
      ...otherParams, // temperature, topP, frequencyPenalty, etc.
    });

    if (stream) {
      let fullText = "";
      for await (const token of result.tokenStream) {
        fullText += token;
      }
      return fullText;
    } else {
      return result.text;
    }
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      history: Array<{ role: string; content: string }>;
      stream?: boolean;
      [key: string]: unknown;
    };
    const text = await this.runCompletion(p);
    return ValidationHelpers.validate(text, expectation as Expectation);
  }
}
