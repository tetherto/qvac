import { getLoadedModelInfo, ModelType } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import {
  loadedModelInfoTests,
  loadedModelInfoLocalHappy,
  loadedModelInfoNotFound,
} from "../../loaded-model-info-tests.js";

export class LoadedModelInfoExecutor extends AbstractModelExecutor<
  typeof loadedModelInfoTests
> {
  pattern = /^loaded-model-info-/;

  protected handlers = {
    [loadedModelInfoLocalHappy.testId]: this.localHappy.bind(this),
    [loadedModelInfoNotFound.testId]: this.notFound.bind(this),
  };

  async localHappy(
    _params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    const llmModelId = await this.resources.ensureLoaded("llm");

    try {
      const info = await getLoadedModelInfo({ modelId: llmModelId });

      if (info.isDelegated) {
        return {
          passed: false,
          output: `Expected isDelegated=false for local model, got isDelegated=true`,
        };
      }

      const checks = {
        modelIdMatches: info.modelId === llmModelId,
        modelTypeCanonical: info.modelType === ModelType.llamacppCompletion,
        handlersIncludesCompletionStream:
          info.handlers.includes("completionStream"),
        loadedAtIsDate: info.loadedAt instanceof Date,
      };

      const allOk = Object.values(checks).every(Boolean);
      const summary = `modelId=${info.modelId.substring(0, 8)}…, modelType=${info.modelType}, handlers=[${info.handlers.join(",")}], checks=${JSON.stringify(checks)}`;

      if (!allOk) {
        return { passed: false, output: `Local info mismatch: ${summary}` };
      }

      return ValidationHelpers.validate(summary, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `getLoadedModelInfo failed: ${errorMsg}` };
    }
  }

  async notFound(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelId: string };

    try {
      await getLoadedModelInfo({ modelId: p.modelId });
      return {
        passed: false,
        output: `Expected getLoadedModelInfo to throw for modelId="${p.modelId}"`,
      };
    } catch (error) {
      const exp = expectation as Expectation;
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (exp.validation === "throws-error") {
        return ValidationHelpers.validate(errorMsg, exp);
      }

      return { passed: false, output: `Unexpected error: ${errorMsg}` };
    }
  }
}
