import { decide, RequestValidationFailedError } from '@qvac/sdk'
import {
  SkipExecutor,
  ValidationHelpers,
  type TestResult,
  type Expectation
} from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { ResourceManager } from '../resource-manager.js'
import { decisionTests } from '../../decision-tests.js'

const questions = {
  department: {
    type: 'choice' as const,
    instructions: 'Which team should handle this ticket?',
    criteria: ['billing', 'technical']
  },
  urgency: {
    type: 'score' as const,
    instructions: 'How urgent is this?',
    criteria: ['not urgent', 'somewhat urgent', 'very urgent']
  },
  refund: { type: 'noul' as const, instructions: 'The customer asks for a refund.' }
}
const state = 'My payment failed twice and I was charged both times. Please refund the duplicate.'

export class DecisionExecutor extends AbstractModelExecutor<typeof decisionTests> {
  pattern = /^decision-/
  protected handlers = {
    'decision-ticket': this.ticket.bind(this),
    'decision-structured-batch': this.batch.bind(this),
    'decision-invalid-budget': this.invalidBudget.bind(this)
  }

  async ticket(_params: object, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('decision')
    return ValidationHelpers.validate(await decide({ modelId, state, questions }), expectation)
  }

  async batch(_params: object, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('decision')
    return ValidationHelpers.validate(
      await decide({
        modelId,
        states: [
          { message: 'The app crashes on startup.' },
          [{ role: 'user', content: "Please send me last month's invoice." }]
        ],
        questions
      }),
      expectation
    )
  }

  async invalidBudget(_params: object, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('decision')
    let rejected = false
    try {
      await decide({ modelId, state, questions, max_len: -1 })
    } catch (error) {
      rejected = error instanceof RequestValidationFailedError
    }
    if (!rejected) throw new Error('Invalid token budget did not produce a validation error')
    const result = await decide({ modelId, state, questions })
    const team = result.answers['department']
    if (team?.type !== 'choice' || team.choice !== 'billing')
      throw new Error('Decision failed after invalid budget')
    return ValidationHelpers.validate('rejected invalid budget; recovered billing', expectation)
  }
}

/** Register the local fixture shared by the desktop and Electron decision tests. */
export function configureDecisionResource(resources: ResourceManager, modelPath?: string) {
  if (!modelPath) {
    return new SkipExecutor(/^decision-/, 'Set QVAC_LAYA_MODEL to a local Laya GGUF.')
  }
  resources.define('decision', {
    modelSrc: modelPath,
    type: 'llamacpp-decision'
  })
  return new DecisionExecutor(resources)
}
