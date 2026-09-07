import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { fitStubCheck } from 'custom-fit-stub-plugin/client'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { fitStubTests, fitStubCheck as fitStubCheckTest } from '../../fit-stub-tests.js'

interface FitStubParams {
  nCtx?: number
  marginMiB?: number
  backendsDir?: string
}

/**
 * Loads a small catalogue GGUF through the `custom-fit-stub-plugin` fixture
 * (which only records the cache path) and asks the plugin to run the
 * header-only fit check in the worker. The whole report is returned as the
 * test output so a failing run is still diagnosable from the results file.
 */
export class FitStubExecutor extends AbstractModelExecutor<typeof fitStubTests> {
  pattern = /^fit-stub-/

  protected handlers = {
    [fitStubCheckTest.testId]: this.check.bind(this)
  }

  async check(params: FitStubParams, expectation: Expectation): Promise<TestResult> {
    try {
      const modelId = await this.resources.ensureLoaded('fit-stub')
      const report = await fitStubCheck(modelId, params)
      return ValidationHelpers.validate(JSON.stringify(report), expectation)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `fit-stub-check failed before producing a report: ${msg}` }
    }
  }
}
