import { getModelInfo } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { modelInfoTests } from "../../model-info-tests.js";

export class ModelInfoExecutor extends AbstractModelExecutor<typeof modelInfoTests> {
  pattern = /^model-info-/;

  protected handlers = Object.fromEntries(
    modelInfoTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

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
}
