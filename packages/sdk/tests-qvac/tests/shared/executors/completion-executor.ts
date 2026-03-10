import { completion } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { completionTests } from "../../completion-tests.js";

export class CompletionExecutor extends AbstractModelExecutor<
  typeof completionTests
> {
  pattern = /^completion-/;

  protected handlers = Object.fromEntries(
    completionTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  private async runCompletion(params: {
    history: Array<{ role: string; content: string }>;
    stream?: boolean;
    [key: string]: unknown;
  }): Promise<string> {
    const llmModelId = await this.resources.ensureLoaded("llm");

    const { history, stream, ...otherParams } = params;
    const result = completion({
      modelId: llmModelId,
      history,
      stream: stream ?? false,
      ...otherParams,
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
