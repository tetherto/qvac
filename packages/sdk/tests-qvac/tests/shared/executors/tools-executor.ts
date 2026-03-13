import { completion } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { toolsTests } from "../../tools-tests.js";

export class ToolsExecutor extends AbstractModelExecutor<typeof toolsTests> {
  pattern = /^tools-/;

  protected handlers = Object.fromEntries(
    toolsTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

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
    const toolsModelId = await this.resources.ensureLoaded("tools");

    try {
      const result = completion({
        modelId: toolsModelId,
        history: p.history,
        tools: p.tools as never,
        stream: p.stream ?? false,
      });

      const text = await result.text;
      const toolCalls = result.toolCalls ? await result.toolCalls : undefined;

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
