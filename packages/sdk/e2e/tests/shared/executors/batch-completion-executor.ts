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
      const llmModelId = await this.resources.ensureLoaded("llm-batch");
      const run = batchCompletion({
        modelId: llmModelId,
        prompts: params.prompts,
        stream: params.stream ?? false,
      });

      if (params.stream) {
        for await (const _event of run.events) {
          // Draining the flat event stream verifies the public streaming path.
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
}
