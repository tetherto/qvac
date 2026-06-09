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
      expectedToolCall?: { name: string; argKeys?: string[] };
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

      if (p.expectedToolCall) {
        const declaredNames = new Set(p.tools.map((t) => t.name));
        return this.validateToolCallShape(toolCalls, p.expectedToolCall, declaredNames);
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

  private validateToolCallShape(
    toolCalls:
      | Array<{ id?: string; name?: string; arguments?: Record<string, unknown> }>
      | undefined,
    expected: { name: string; argKeys?: string[] },
    declaredNames: Set<string>,
  ): TestResult {
    if (!toolCalls || toolCalls.length === 0) {
      return { passed: false, output: "Expected a structured tool call but the model returned none" };
    }

    const valid = toolCalls.filter(
      (c) => typeof c.name === "string" && declaredNames.has(c.name),
    );
    if (valid.length === 0) {
      const got = toolCalls.map((c) => c.name ?? "<unnamed>").join(", ");
      return { passed: false, output: `No tool call matched a declared tool. Got: [${got}], declared: [${[...declaredNames].join(", ")}]` };
    }

    const match = valid.find((c) => c.name === expected.name);
    if (match) {
      const args = match.arguments ?? {};
      for (const key of expected.argKeys ?? []) {
        if (!(key in args)) {
          return { passed: false, output: `Tool call '${expected.name}' missing argument key '${key}'. Got: ${JSON.stringify(args)}` };
        }
      }
    }

    return { passed: true, output: `Tool call(s): ${valid.map((c) => c.name).join(", ")}` };
  }
}
