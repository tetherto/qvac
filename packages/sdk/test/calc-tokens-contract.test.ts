import test from 'brittle'
import { calcTokensRequestSchema } from '@qvac/inference/surface'
import { buildContract } from '../scripts/contract/build-contract'
import { contractValidate } from './utils/contract-validator'

test('calcTokens is a typed unary method in the generated client contract', (t) => {
  const { manifest } = buildContract()
  const method = manifest.methods.find((candidate) => candidate.name === 'calcTokens')
  t.is(method?.callShape, 'request-reply')

  const request = {
    type: 'calcTokens' as const,
    modelId: 'llm',
    history: [{ role: 'user' as const, content: 'Hello' }],
    text: 'How many tokens?'
  }
  t.alike(calcTokensRequestSchema.parse(request), request)
  t.ok(contractValidate('calcTokens.request', request).valid)
  t.ok(contractValidate('calcTokens.response', { type: 'calcTokens', tokens: 12 }).valid)
  t.absent(contractValidate('calcTokens.response', { type: 'calcTokens', tokens: -1 }).valid)
})
