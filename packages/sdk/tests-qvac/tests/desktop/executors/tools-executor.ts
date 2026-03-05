// Tools/Function calling executor
import { completion } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { toolsTests } from "../../tools-tests.js";
import { ModelManager } from "../model-manager.js";

export class ToolsExecutor {
  pattern = /^tools-/;

  // All tools tests use generic handler
  handlers = Object.fromEntries(
    toolsTests.map((test) => [test.testId, this.generic]),
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
      history: Array<{ role: string; content: string }>;
      tools: Array<{
        type: "function";
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      }>;
      stream?: boolean;
    };
    const toolsModelId = await ModelManager.getToolsModel(); // Use Qwen with correct config

    try {
      const result = completion({
        modelId: toolsModelId,
        history: p.history,
        tools: p.tools as never, // SDK has strict types, cast for now
        stream: p.stream ?? false,
      });

      // Tools completion returns { text: Promise<string>, toolCalls: Promise<array>, stats }
      const text = await result.text;
      const toolCalls = result.toolCalls ? await result.toolCalls : undefined;

      // Validate we got a response (text or toolCalls)
      const resultData =
        text ||
        (toolCalls && toolCalls.length > 0 ? "tool call made" : "no response");

      return ValidationHelpers.validate(resultData, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Tools test failed: ${errorMsg}` };
    }
  }
}
