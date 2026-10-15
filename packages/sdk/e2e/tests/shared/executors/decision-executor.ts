import { decide, RequestValidationFailedError } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  decisionTests,
  type DecisionSingleParams,
  type DecisionBatchParams,
  type DecisionInvalidBudgetParams
} from '../../decision-tests.js'

export class DecisionExecutor extends AbstractModelExecutor<typeof decisionTests> {
  pattern = /^decision-/
  protected handlers = {
    'decision-ticket': this.ticket.bind(this),
    'decision-concurrent-queued': this.concurrent.bind(this),
    'decision-structured-batch': this.batch.bind(this),
    'decision-invalid-budget': this.invalidBudget.bind(this)
  }

  async ticket(params: DecisionSingleParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('decision')
    return ValidationHelpers.validate(await decide({ ...params, modelId }), expectation)
  }

  async concurrent(params: DecisionBatchParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('decision')
    const { states, ...request } = params
    const results = await Promise.all(states.map((state) => decide({ ...request, modelId, state })))
    return ValidationHelpers.validate(
      results
        .map((result) =>
          result.answers['department']?.type === 'choice' ? result.answers['department'].choice : ''
        )
        .join(', '),
      expectation
    )
  }

  async batch(params: DecisionBatchParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('decision')
    return ValidationHelpers.validate(await decide({ ...params, modelId }), expectation)
  }

  async invalidBudget(
    params: DecisionInvalidBudgetParams,
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('decision')
    let rejected = false
    try {
      await decide({ ...params.invalid, modelId })
    } catch (error) {
      rejected = error instanceof RequestValidationFailedError
    }
    if (!rejected) throw new Error('Invalid token budget did not produce a validation error')
    const result = await decide({ ...params.recovery, modelId })
    const team = result.answers['department']
    if (team?.type !== 'choice' || team.choice !== 'billing')
      throw new Error('Decision failed after invalid budget')
    return ValidationHelpers.validate('rejected invalid budget; recovered billing', expectation)
  }
}
