import type { Expectation } from './test-definition.js';
import type { TestResult } from '../core/consumer-base.js';

/**
 * Test handler interface - implement this to handle test execution
 */
export interface TestHandler<TParams = unknown, TContext = Record<string, unknown>> {
  /** Pattern to match test IDs (e.g., /^api-/) */
  pattern: RegExp;

  /**
   * Execute a test
   * @param testId - Unique test identifier
   * @param context - Test context (metadata from test definition)
   * @param params - Test parameters
   * @param expectation - Expected outcome specification
   * @returns Test result
   */
  execute(testId: string, context: TContext, params: TParams, expectation: Expectation): Promise<TestResult>;
}

/**
 * Test executor configuration
 */
export interface TestExecutorConfig {
  /** Array of test handlers */
  handlers: TestHandler[];
}
