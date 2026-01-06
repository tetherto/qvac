// TODO placeholder executor
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";

export class TodoExecutor {
  pattern = /^todo-/;

  async execute(
    testId: string,
    context: unknown,
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    // TODO tests are placeholders - just return success
    return ValidationHelpers.validate(
      "TODO test placeholder",
      expectation as Expectation,
    );
  }
}
