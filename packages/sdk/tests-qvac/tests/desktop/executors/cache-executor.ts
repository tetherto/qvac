// Cache management executor
import { getModelInfo, deleteCache } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { cacheTests } from "../../cache-tests.js";

export class CacheExecutor {
  pattern = /^cache-/;

  // All cache tests use generic handler
  handlers = Object.fromEntries(
    cacheTests.map((test) => [test.testId, this.generic]),
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
    const p = params as Record<string, unknown>;

    try {
      let result: unknown;

      if (p.deleteAll) {
        result = await deleteCache({ all: true });
      } else if (p.kvCacheKey) {
        result = await deleteCache({ kvCacheKey: p.kvCacheKey as string });
      } else if (p.modelConstant) {
        result = await getModelInfo({ name: p.modelConstant as string });
      }

      // Cache APIs return objects - serialize for validation
      const resultStr =
        typeof result === "string"
          ? result
          : result
            ? JSON.stringify(result)
            : "success";
      return ValidationHelpers.validate(resultStr, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Cache operation failed: ${errorMsg}` };
    }
  }
}
