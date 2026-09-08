import type { TestHandler, TestExecutorConfig, Profiler } from '../types/test-handler.js'
import type { TestExecutor, TestResult } from './consumer-base.js'
import type { Expectation } from '../types/test-definition.js'
import type { ProfilerExport } from '../schemas/messages.js'

/**
 * Creates a test executor from a configuration of handlers
 */
export function createExecutor(config: TestExecutorConfig): TestExecutor {
  return new DefaultTestExecutor(config.handlers, config.profiling)
}

/**
 * Default test executor implementation
 */
class DefaultTestExecutor implements TestExecutor {
  private handlers: TestHandler[]
  private profiler?: Profiler

  constructor(handlers: TestHandler[], profiler?: Profiler) {
    this.handlers = handlers
    this.profiler = profiler
  }

  private findHandler(testId: string): TestHandler | undefined {
    return this.handlers.find((h) => h.pattern.test(testId))
  }

  async setup(testId: string, context: unknown): Promise<void> {
    const handler = this.findHandler(testId)
    if (handler?.setup) {
      const handlerContext = (context && typeof context === 'object' ? context : {}) as Record<
        string,
        unknown
      >
      await handler.setup(testId, handlerContext)
    }
  }

  async executeTest(
    testId: string,
    context: unknown,
    params: unknown,
    expectation: Expectation
  ): Promise<TestResult> {
    const handler = this.findHandler(testId)

    if (!handler) {
      return {
        passed: false,
        output: `No handler found for test: ${testId}. Registered patterns: ${this.handlers.map((h) => h.pattern.source).join(', ')}`
      }
    }

    try {
      const handlerContext = (context && typeof context === 'object' ? context : {}) as Record<
        string,
        unknown
      >
      return await handler.execute(testId, handlerContext, params, expectation)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        passed: false,
        output: `Handler execution failed: ${errorMessage}`
      }
    }
  }

  async teardown(testId: string, context: unknown): Promise<void> {
    const handler = this.findHandler(testId)
    if (handler?.teardown) {
      const handlerContext = (context && typeof context === 'object' ? context : {}) as Record<
        string,
        unknown
      >
      await handler.teardown(testId, handlerContext)
    }
  }

  async reload(testId: string, context: unknown): Promise<void> {
    const handler = this.findHandler(testId)
    if (handler?.reload) {
      const handlerContext = (context && typeof context === 'object' ? context : {}) as Record<
        string,
        unknown
      >
      await handler.reload(testId, handlerContext)
    }
  }

  initProfiling(): void {
    if (this.profiler) {
      this.profiler.init()
    }
  }

  getProfilingData(): ProfilerExport | undefined {
    if (!this.profiler) return undefined
    return this.profiler.exportData() as ProfilerExport | undefined
  }
}
