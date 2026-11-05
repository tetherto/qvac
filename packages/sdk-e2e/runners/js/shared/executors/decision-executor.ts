import { decide, RequestValidationFailedError } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  decisionTests,
  type DecisionSingleParams,
  type DecisionBatchParams,
  type DecisionInvalidBudgetParams
} from '../../../../catalog/decision-tests.js'

export class DecisionExecutor extends AbstractModelExecutor<typeof decisionTests> {
  pattern = /^decision-/
  protected handlers = {
    'decision-ticket': this.ticket.bind(this),
    'decision-concurrent-queued': this.concurrent.bind(this),
    'decision-structured-batch': this.batch.bind(this),
    'decision-structured-batch-parity': this.batchParity.bind(this),
    'decision-invalid-budget': this.invalidBudget.bind(this)
  }

  async ticket(params: DecisionSingleParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('decision')
    const reference = [await decide({ ...params, modelId })]
    const results = [await decide({ ...params, modelId })]
    return ValidationHelpers.validate({ results, reference }, expectation)
  }

  async concurrent(params: DecisionBatchParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('decision')
    const { states, ...request } = params
    const reference = []
    for (const state of states) reference.push(await decide({ ...request, modelId, state }))
    const results = await Promise.all(states.map((state) => decide({ ...request, modelId, state })))
    return ValidationHelpers.validate({ results, reference }, expectation)
  }

  async batchParity(params: DecisionBatchParams, expectation: Expectation): Promise<TestResult> {
    return this.batch(params, expectation, 'decision-parity')
  }

  async batch(
    params: DecisionBatchParams,
    expectation: Expectation,
    dependency = 'decision'
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded(dependency)
    const { states, ...request } = params
    const reference = []
    for (const state of states) reference.push(await decide({ ...request, modelId, state }))
    const results = await decide({ ...params, modelId })
    return ValidationHelpers.validate({ results, reference }, expectation)
  }

  async invalidBudget(
    params: DecisionInvalidBudgetParams,
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('decision')
    const reference = [await decide({ ...params.recovery, modelId })]
    let rejected = false
    try {
      await decide({ ...params.invalid, modelId })
    } catch (error) {
      rejected = error instanceof RequestValidationFailedError
    }
    if (!rejected) throw new Error('Invalid token budget did not produce a validation error')
    const results = [await decide({ ...params.recovery, modelId })]
    return ValidationHelpers.validate({ results, reference }, expectation)
  }
}
