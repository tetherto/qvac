import type { TestDefinition } from '@qvac/test-suite'

export const calcTokensPrompt: TestDefinition = {
  testId: 'calc-tokens-llm-prompt',
  params: {
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
    { compare: { left: '$shortCount', right: '0', named: 'greaterThan' } },
    { compare: { left: '$longCount', right: '$shortCount', named: 'greaterThan' } }
  ],
  metadata: { category: 'completion', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const calcTokensTests = [calcTokensPrompt]
