import { completion, ToolsModeType } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { toolsTests, type ToolsExpectation } from "../../tools-tests.js";

export class ToolsExecutor extends AbstractModelExecutor<typeof toolsTests> {
  pattern = /^tools-/;

  protected handlers = Object.fromEntries(
    toolsTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  async generic(params: unknown, expectation: ToolsExpectation): Promise<TestResult> {
    const p = params as {
      history: Array<{ role: string; content: string }>;
      tools: Array<{
        type: "function";
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      }>;
      toolsMode: string,
      stream?: boolean;
    };
    const resourceDep = p.toolsMode  === ToolsModeType.dynamic ? "tools-dynamic" : "tools"
    const toolsModelId = await this.resources.ensureLoaded(resourceDep);

    try {
      const result = completion({
        modelId: toolsModelId,
        history: p.history,
        tools: p.tools as never,
        stream: p.stream ?? false,
      });

      const text = await result.text;
      const toolCalls = result.toolCalls ? await result.toolCalls : undefined;

      if (expectation.validation === "type") {
        const resultData =
          text ||
          (toolCalls && toolCalls.length > 0 ? "tool call made" : "no response");
        return ValidationHelpers.validate(resultData, expectation as Expectation);
      }

      if (expectation.validation === "custom") {
        const passed = expectation.validator({ toolCalls, text });
        return {
          passed,
          output: passed
            ? "custom validator passed"
            : "custom validator returned false",
        };
      }

      return {
        passed: false,
        output: `Unhandled validation type: ${(expectation as { validation: string }).validation}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Tools test failed: ${errorMsg}` };
    }
  }
}
