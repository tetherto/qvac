import { getLoadedModelInfo, getModelInfo, ModelType } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import {
  modelInfoTests,
  modelInfoLoadedGet,
  modelInfoLoadedNotFound,
} from "../../model-info-tests.js";

export class ModelInfoExecutor extends AbstractModelExecutor<typeof modelInfoTests> {
  pattern = /^model-info-/;

  protected handlers = {
    ...Object.fromEntries(
      modelInfoTests
        .filter(
          (t) =>
            t.testId !== modelInfoLoadedGet.testId &&
            t.testId !== modelInfoLoadedNotFound.testId,
        )
        .map((t) => [t.testId, this.generic.bind(this)]),
    ),
    [modelInfoLoadedGet.testId]: this.loadedGet.bind(this),
    [modelInfoLoadedNotFound.testId]: this.loadedNotFound.bind(this),
  } as never;

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelConstant?: string; models?: string[] };

    try {
      if (p.models) {
        const results = await Promise.all(
          p.models.map((name) => getModelInfo({ name })),
        );
        const resultStr = `Got info for ${results.length} models`;
        return ValidationHelpers.validate(resultStr, expectation as Expectation);
      }

      if (p.modelConstant) {
        const info = await getModelInfo({ name: p.modelConstant });
        const resultStr = `isCached=${info.isCached}, files=${info.cacheFiles?.length ?? 0}`;
        return ValidationHelpers.validate(resultStr, expectation as Expectation);
      }

      return { passed: false, output: "No model info params provided" };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Model info failed: ${errorMsg}` };
    }
  }

  async loadedGet(_params: unknown, expectation: unknown): Promise<TestResult> {
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

  async loadedNotFound(
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
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
