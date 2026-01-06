import { testDefinitionSchema, type TestDefinition } from '../types/test-definition.js';

/**
 * Helper function to define tests with type safety and validation
 */
export function defineTests(tests: TestDefinition[]): TestDefinition[] {
  return tests.map((test, idx) => {
    try {
      return testDefinitionSchema.parse(test);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Test definition ${idx} (${test.testId || 'unknown'}) is invalid: ${errorMessage}`);
    }
  });
}
