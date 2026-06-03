import { completion } from "@qvac/sdk";
import type { ToolDialect } from "@qvac/sdk";
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
      toolsMode?: "static" | "dynamic";
      toolDialect?: ToolDialect;
      resourceKey?: string;
      stream?: boolean;
      // When set, assert the model actually emitted a structured tool call with
      // this function name and these argument keys — not just that it returned
      // some text. The default path below only validates the text string, which
      // silently passes even when the tool name or arguments are wrong.
      expectedToolCall?: {
        name: string;
        argKeys?: string[];
      };
    };
    const resourceKey = p.resourceKey ?? (p.toolsMode === "dynamic" ? "tools-dynamic" : "tools");
    const toolsModelId = await this.resources.ensureLoaded(resourceKey);

    try {
      const result = completion({
        modelId: toolsModelId,
        history: p.history,
        tools: p.tools as never,
        stream: p.stream ?? false,
        ...(p.toolDialect && { toolDialect: p.toolDialect }),
      });

      const text = await result.text;
      const toolCalls = result.toolCalls ? await result.toolCalls : undefined;

      // Shape-asserting path: when a test declares expectedToolCall, verify the
      // structured tool_call (name + argument keys) rather than the text blob.
      if (p.expectedToolCall) {
        return this.validateToolCallShape(toolCalls, p.expectedToolCall);
      }

      const resultData =
        text ||
        (toolCalls && toolCalls.length > 0 ? "tool call made" : "no response");

      return ValidationHelpers.validate(resultData, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Tools test failed: ${errorMsg}` };
    }
  }

  // Behavior/shape check only — deliberately does NOT assert which tool the
  // model picked or its argument values (that is model quality, checked at the
  // addon level). We verify the SDK produced a STRUCTURED tool call: at least
  // one call with a non-empty string name (proves the parser ran, not text).
  // If the expected tool happens to be the one called, we also confirm its
  // requested argument KEYS are present (structure, not values). A different
  // valid tool still passes.
  private validateToolCallShape(
    toolCalls:
      | Array<{ id?: string; name?: string; arguments?: Record<string, unknown> }>
      | undefined,
    expected: { name: string; argKeys?: string[] },
  ): TestResult {
    if (!toolCalls || toolCalls.length === 0) {
      return {
        passed: false,
        output: "Expected a structured tool call but the model returned none",
      };
    }

    const named = toolCalls.filter(
      (c) => typeof c.name === "string" && c.name.length > 0,
    );
    if (named.length === 0) {
      return {
        passed: false,
        output: `Tool calls present but none has a non-empty name: ${JSON.stringify(toolCalls)}`,
      };
    }

    // Only check arg-key structure when the expected tool is the one chosen;
    // we don't penalize a different (valid) tool choice.
    const match = named.find((c) => c.name === expected.name);
    if (match) {
      const args = match.arguments ?? {};
      for (const key of expected.argKeys ?? []) {
        if (!(key in args)) {
          return {
            passed: false,
            output: `Tool call '${expected.name}' missing argument key '${key}'. Got args: ${JSON.stringify(args)}`,
          };
        }
      }
    }

    return {
      passed: true,
      output: `Structured tool call(s): ${named.map((c) => c.name).join(", ")}`,
    };
  }
}
