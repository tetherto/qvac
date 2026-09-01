import type { Expectation } from './test-definition.js'
import type { TestResult } from '../core/consumer-base.js'

/**
 * Test handler interface - implement this to handle test execution
 */
export interface TestHandler<TParams = unknown, TContext = Record<string, unknown>> {
  /** Pattern to match test IDs (e.g., /^api-/) */
  pattern: RegExp

  /**
   * Called before test execution, outside the timeout window.
   * Use for resource loading, model setup, or other slow preparation.
   */
  setup?(testId: string, context: TContext): Promise<void>

  /**
   * Execute a test
   * @param testId - Unique test identifier
   * @param context - Test context (metadata from test definition)
   * @param params - Test parameters
   * @param expectation - Expected outcome specification
   * @returns Test result
   */
  execute(
    testId: string,
    context: TContext,
    params: TParams,
    expectation: Expectation
  ): Promise<TestResult>

  /**
   * Called after test execution (success or failure), outside the timeout window.
   * Use for cleanup, resource eviction, or state reset.
   */
  teardown?(testId: string, context: TContext): Promise<void>

  /**
   * Called between the first failed attempt and the retry when `retryOnFailure` is true.
   * Implementations should fully unload model resources and re-run setup so the retry
   * starts from a clean state. Optional: if absent, the retry still runs but without reload.
   */
  reload?(testId: string, context: TContext): Promise<void>
}

/**
 * Profiler interface for test executor.
 */
export interface Profiler {
  init: () => void
  exportData: () => unknown
}

/**
 * Test executor configuration
 */
export interface TestExecutorConfig {
  /** Array of test handlers */
  handlers: TestHandler[]
  /** Optional profiler */
  profiling?: Profiler
}
