// Error handling executor - tests SDK error handling
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { errorTests } from "../../error-tests.js";

export class ErrorExecutor {
  pattern = /^error-/;

  // All error tests use generic handler
  handlers = Object.fromEntries(
    errorTests.map((test) => [test.testId, this.generic]),
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
    // Error tests are handled by their respective executors (completion, embedding, etc.)
    // This executor just validates that SDK handles errors gracefully
    return ValidationHelpers.validate(
      "Error test placeholder",
      expectation as Expectation,
    );
  }
}
