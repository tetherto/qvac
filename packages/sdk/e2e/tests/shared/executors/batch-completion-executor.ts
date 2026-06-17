import { batchCompletion } from "@qvac/sdk";
import {
  ValidationHelpers,
  type Expectation,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { batchCompletionTests } from "../../batch-completion-tests.js";

interface BatchCompletionTestParams {
  prompts: Parameters<typeof batchCompletion>[0]["prompts"];
  stream?: boolean;
  resourceKey?: string;
  toolDialect?: Parameters<typeof batchCompletion>[0]["toolDialect"];
  expectedToolCall?: {
    id: string;
    name: string;
    argKeys?: string[];
    noToolCallIds?: string[];
  };
}

export class BatchCompletionExecutor extends AbstractModelExecutor<
  typeof batchCompletionTests
> {
  pattern = /^batch-completion-/;

  protected handlers = Object.fromEntries(
    batchCompletionTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  async generic(
    params: BatchCompletionTestParams,
    expectation: Expectation,
  ): Promise<TestResult> {
    try {
      const llmModelId = await this.resources.ensureLoaded(
        params.resourceKey ?? "llm-batch",
      );
      const run = batchCompletion({
        modelId: llmModelId,
        prompts: params.prompts,
        stream: params.stream ?? false,
        ...(params.toolDialect && { toolDialect: params.toolDialect }),
      });

      const streamedContentCounts: Record<string, number> = {};
      if (params.stream) {
        for await (const { id, event } of run.events) {
          if (event.type === "contentDelta" && event.text.length > 0) {
            streamedContentCounts[id] = (streamedContentCounts[id] ?? 0) + 1;
          }
        }
      }

      const ids = await run.ids;
      const results = await run.results;
      if (ids.length !== params.prompts.length) {
        return {
          passed: false,
          output: `Expected ${params.prompts.length} ids, got ${ids.length}`,
        };
      }
      if (params.stream) {
        const missingStreamedContent = ids.filter(
          (id) => (streamedContentCounts[id] ?? 0) === 0,
        );
        if (missingStreamedContent.length > 0) {
          return {
            passed: false,
            output: `Missing streamed content for ids: ${missingStreamedContent.join(", ")}`,
          };
        }

        const byIdResults = await Promise.all(
          ids.map(async (id) => ({
            id,
            final: await run.byId(id).final,
          })),
        );
        const mismatched = results.filter((result, index) => {
          const byIdResult = byIdResults[index];
          return (
            byIdResult === undefined ||
            byIdResult.id !== result.id ||
            byIdResult.final.contentText !== result.final.contentText
          );
        });
        if (mismatched.length > 0) {
          return {
            passed: false,
            output: `byId finals diverged for ids: ${mismatched
              .map((result) => result.id)
              .join(", ")}`,
          };
        }
      }

      if (params.expectedToolCall) {
        return await this.validateToolCall(
          run,
          results,
          params.expectedToolCall,
        );
      }

      const output = results
        .map((result) => `${result.id}:${result.final.contentText}`)
        .join("\n");
      return ValidationHelpers.validate(output, expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (expectation.validation === "throws-error") {
        return ValidationHelpers.validate(errorMsg, expectation);
      }
      return { passed: false, output: `batchCompletion failed: ${errorMsg}` };
    }
  }

  private async validateToolCall(
    run: ReturnType<typeof batchCompletion>,
    results: Awaited<ReturnType<typeof batchCompletion>["results"]>,
    expected: NonNullable<BatchCompletionTestParams["expectedToolCall"]>,
  ): Promise<TestResult> {
    const targetResult = results.find((result) => result.id === expected.id);
    if (!targetResult) {
      return {
        passed: false,
        output: `Expected result id ${expected.id}, got: ${results
          .map((result) => result.id)
          .join(", ")}`,
      };
    }

    const byIdFinal = await run.byId(expected.id).final;
    if (byIdFinal.toolCalls.length !== targetResult.final.toolCalls.length) {
      return {
        passed: false,
        output: `byId(${expected.id}) tool calls diverged from aggregate result`,
      };
    }

    const match = targetResult.final.toolCalls.find(
      (call) => call.name === expected.name,
    );
    if (!match) {
      return {
        passed: false,
        output: `Expected tool call ${expected.name}, got: ${targetResult.final.toolCalls
          .map((call) => call.name)
          .join(", ")}`,
      };
    }

    for (const key of expected.argKeys ?? []) {
      if (!(key in match.arguments)) {
        return {
          passed: false,
          output: `Tool call ${expected.name} missing argument ${key}. Got: ${JSON.stringify(match.arguments)}`,
        };
      }
    }

    for (const id of expected.noToolCallIds ?? []) {
      const final = await run.byId(id).final;
      if (final.toolCalls.length > 0) {
        return {
          passed: false,
          output: `Expected no tool calls for ${id}, got: ${final.toolCalls
            .map((call) => call.name)
            .join(", ")}`,
        };
      }
    }

    return {
      passed: true,
      output: `Tool call ${expected.name} routed to ${expected.id}`,
    };
  }
}
