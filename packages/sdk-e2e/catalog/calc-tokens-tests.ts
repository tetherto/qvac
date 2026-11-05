import type { TestDefinition } from '@qvac/test-suite'

export interface CalcTokensPromptParams {
  shortText: string
  longText: string
  zero: number
}

export interface CalcTokensInvalidParams {
  request: Record<string, unknown>
  field: string
}

export interface CalcTokensToolsParams {
  text: string
  tool: typeof weatherTool
}

const weatherTool = {
  type: 'function' as const,
  name: 'weather',
  description: 'Get weather for a city.',
  parameters: {
    type: 'object' as const,
    properties: { city: { type: 'string' as const } },
    required: ['city']
  }
}

export const calcTokensPrompt: TestDefinition = {
  testId: 'calc-tokens-llm-prompt',
  params: {
    shortText: 'Hello',
    longText: 'Hello, world. Please count every token in this deliberately longer sentence.',
    zero: 0
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
    { assert: { on: '$shortCount', use: 'expectation' } },
    { compare: { left: '$longCount', right: '$shortCount', named: 'greaterThan' } }
  ],
  metadata: { category: 'completion', dependency: 'llm', estimatedDurationMs: 5000 }
}

function rejectsInvalid(
  testId: string,
  request: Record<string, unknown>,
  field: string
): TestDefinition {
  return {
    testId,
    params: { request, field },
    expectation: { validation: 'throws-error', errorContains: field },
    steps: [
      {
        callError: {
          method: 'calcTokens',
          params: request,
          as: 'err'
        }
      },
      { assert: { on: '$err', named: 'errorMatches', with: { messageContains: field } } }
    ],
    metadata: { category: 'completion', dependency: 'none', estimatedDurationMs: 1000 }
  }
}

export const calcTokensRejectsMissingPrompt = rejectsInvalid(
  'calc-tokens-rejects-missing-prompt',
  { modelId: 'calc-tokens-invalid' },
  'text'
)

export const calcTokensRejectsUnknownKey = rejectsInvalid(
  'calc-tokens-rejects-unknown-key',
  { modelId: 'calc-tokens-invalid', text: 'Hello', unknown: true },
  'unknown'
)

export const calcTokensRejectsNonLlm: TestDefinition = {
  testId: 'calc-tokens-rejects-non-llm',
  params: {},
  expectation: { validation: 'throws-error', errorContains: 'does not support calcTokens' },
  steps: [
    { useModel: { deps: ['embeddings'], as: 'model' } },
    {
      callError: {
        method: 'calcTokens',
        params: { modelId: '$model', text: 'Hello' },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  metadata: { category: 'completion', dependency: 'embeddings', estimatedDurationMs: 5000 }
}

export const calcTokensCountsTools: TestDefinition = {
  testId: 'calc-tokens-counts-tools',
  params: { text: 'What is the weather?', tool: weatherTool },
  expectation: { validation: 'type', expectedType: 'number' },
  steps: [
    { useModel: { deps: ['tools'], as: 'model' } },
    {
      call: {
        method: 'calcTokens',
        params: { modelId: '$model', text: '$params.text' },
        as: 'plainCount'
      }
    },
    {
      call: {
        method: 'calcTokens',
        params: { modelId: '$model', text: '$params.text', tools: ['$params.tool'] },
        as: 'toolCount'
      }
    },
    { assert: { on: '$toolCount', use: 'expectation' } },
    { compare: { left: '$toolCount', right: '$plainCount', named: 'greaterThan' } }
  ],
  metadata: { category: 'completion', dependency: 'tools', estimatedDurationMs: 5000 }
}

export const calcTokensTests = [
  calcTokensPrompt,
  calcTokensRejectsMissingPrompt,
  calcTokensRejectsUnknownKey,
  calcTokensRejectsNonLlm,
  calcTokensCountsTools
]
