import test from 'brittle'
import { createCalcTokensCall } from '@/client/api/calc-tokens'
import { InvalidResponseError } from '@/utils/errors-client'

const params = {
  modelId: 'llm',
  history: [{ role: 'user' as const, content: 'Hello' }],
  text: 'How many tokens?'
}

test('calcTokens sends the prompt and returns the non-negative integer count', async (t) => {
  let request: unknown
  const tokens = await createCalcTokensCall(params, undefined, async (input) => {
    request = input
    return { type: 'calcTokens', tokens: 12 }
  })

  t.is(tokens, 12)
  t.alike(request, { ...params, type: 'calcTokens' })
})

test('calcTokens rejects invalid input before RPC', async (t) => {
  let called = false
  await t.exception(() =>
    createCalcTokensCall({ modelId: 'llm' } as typeof params, undefined, async () => {
      called = true
      return { type: 'calcTokens', tokens: 1 }
    })
  )
  t.absent(called)
})

test('calcTokens rejects malformed responses', async (t) => {
  for (const response of [
    { type: 'heartbeat', alive: true },
    { type: 'calcTokens', tokens: -1 },
    { type: 'calcTokens', tokens: 1.5 },
    { type: 'calcTokens', tokens: '12' }
  ]) {
    await t.exception(
      () => createCalcTokensCall(params, undefined, async () => response as never),
      InvalidResponseError as unknown as new () => Error
    )
  }
})
