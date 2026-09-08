import type { TestResult } from './consumer-base.js'
import type { TestDefinition } from '../types/test-definition.js'

/**
 * Test definition array type
 */
export type TestDefinitions = readonly TestDefinition[]

/**
 * Extract a specific test definition by testId
 */
export type ExtractTest<
  TDefs extends TestDefinitions,
  TId extends TDefs[number]['testId']
> = Extract<TDefs[number], { testId: TId }>

/**
 * Handler function signature inferred from test definition
 */
export type HandlerFn<TDef extends TestDefinition> = (
  params: TDef['params'],
  expectation: TDef['expectation']
) => Promise<TestResult>

/**
 * Base executor - handles test dispatch and type-safe handler binding
 * Platform-agnostic: no filesystem, no asset APIs
 */
export abstract class BaseExecutor<TDefs extends TestDefinitions> {
  abstract pattern: RegExp

  /**
   * Handler map: testId → handler method
   * Each handler gets type-safe params/expectation based on test definition
   */
  protected abstract handlers: {
    [K in TDefs[number]['testId']]?: HandlerFn<ExtractTest<TDefs, K>>
  }

  /**
   * Optional default handler for tests not in handlers map
   */
  protected defaultHandler?: (
    testId: string,
    params: unknown,
    expectation: unknown
  ) => Promise<TestResult>

  /**
   * Override to perform setup before test execution (e.g., load models, acquire resources).
   * Runs outside the test timeout window.
   */
  async setup?(testId: string, context: unknown): Promise<void>

  /**
   * Override to perform cleanup after test execution (e.g., evict resources).
   * Runs outside the test timeout window.
   */
  async teardown?(testId: string, context: unknown): Promise<void>

  async execute(
    testId: string,
    context: unknown,
    params: unknown,
    expectation: unknown
  ): Promise<TestResult> {
    const handler = this.handlers[testId as keyof typeof this.handlers]

    if (handler) {
      return await handler(params as never, expectation as never)
    }

    if (this.defaultHandler) {
      return await this.defaultHandler(testId, params, expectation)
    }

    return { passed: false, output: `Unknown test: ${testId}` }
  }
}

/**
 * Skip executor - marks tests as skipped without executing
 */
export class SkipExecutor {
  constructor(
    // lunte-disable-next-line no-unused-vars
    public pattern: RegExp,
    private reason?: string
  ) {}

  // lunte-disable-next-line require-await
  async execute(_testId: string): Promise<TestResult> {
    return {
      passed: true,
      output: `SKIPPED: ${this.reason || 'Not supported on this platform'}`,
      skipped: true
    }
  }
}
