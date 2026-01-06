// Handler-based executor for Step 4 validation
import { createExecutor, ValidationHelpers } from '../../../framework/dist/index.js';

// Sample handler for sample-* tests
class SampleExecutor {
  pattern = /^sample-/;

  async execute(testId, context, params, expectation) {
    console.log(`  [SampleExecutor] Running ${testId}`);

    // Simulate some work
    await new Promise((resolve) => setTimeout(resolve, 100));

    // For sample-test-1: return the input string
    if (testId === 'sample-test-1') {
      return ValidationHelpers.validate(params.input, expectation);
    }

    // For sample-test-2: return the numeric value
    if (testId === 'sample-test-2') {
      return ValidationHelpers.validate(params.value, expectation);
    }

    return { passed: false, output: 'Unknown test' };
  }
}

// Create executor with handlers
export const executor = createExecutor({
  handlers: [new SampleExecutor()],
});
