import type { TestHandler, TestExecutorConfig } from '../types/test-handler.js';
import type { TestExecutor, TestResult } from './consumer-base.js';
import type { Expectation } from '../types/test-definition.js';

/**
 * Creates a test executor from a configuration of handlers
 */
export function createExecutor(config: TestExecutorConfig): TestExecutor {
  return new DefaultTestExecutor(config.handlers);
}

/**
 * Default test executor implementation
 */
class DefaultTestExecutor implements TestExecutor {
  private handlers: TestHandler[];

  constructor(handlers: TestHandler[]) {
    this.handlers = handlers;
  }

  async executeTest(testId: string, context: unknown, params: unknown, expectation: Expectation): Promise<TestResult> {
    // Find matching handler
    const handler = this.handlers.find((h) => h.pattern.test(testId));

    if (!handler) {
      return {
        passed: false,
        output: `No handler found for test: ${testId}. Registered patterns: ${this.handlers.map((h) => h.pattern.source).join(', ')}`,
      };
    }

    try {
      // Context is metadata from test definition (Record or empty object)
      const handlerContext = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
      return await handler.execute(testId, handlerContext, params, expectation);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        passed: false,
        output: `Handler execution failed: ${errorMessage}`,
      };
    }
  }
}
