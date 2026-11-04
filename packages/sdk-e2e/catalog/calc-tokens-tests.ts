import type { TestDefinition } from '@qvac/test-suite'

export interface CalcTokensPromptParams {
  shortText: string
  longText: string
}

export const calcTokensPrompt: TestDefinition = {
  testId: 'calc-tokens-llm-prompt',
  params: {
    zero: 0,
    shortText: 'Hello',
    longText: 'Hello, world. Please count every token in this deliberately longer sentence.'
  },
  expectation: { validation: 'type', expectedType: 'number' },
  suites: ['smoke'],
  steps: [
    { useModel: { deps: ['llm'], as: 'model' } },
    {
      call: {
        method: 'calcTokens',
        params: { modelId: '$model', text: '$params.shortText' },
        as: 'shortCount'
      }
    },
    {
      call: {
        method: 'calcTokens',
        params: {
          modelId: '$model',
          history: [{ role: 'system', content: 'You are concise.' }],
          text: '$params.longText'
        },
        as: 'longCount'
      }
    },
    { compare: { left: '$shortCount', right: '$params.zero', named: 'greaterThan' } },
    { compare: { left: '$longCount', right: '$shortCount', named: 'greaterThan' } }
  ],
  metadata: { category: 'completion', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const calcTokensTests = [calcTokensPrompt]
