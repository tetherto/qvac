import test from 'brittle'
import { z } from 'zod'
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

test('calcTokens converts Zod tool inputs like completion', async (t) => {
  let request: unknown
  await createCalcTokensCall(
    {
      modelId: 'llm',
      text: 'Weather in Paris?',
      tools: [
        {
          name: 'weather',
          description: 'Get weather',
          parameters: z.object({ city: z.string() })
        }
      ]
    },
    undefined,
    async (input) => {
      request = input
      return { type: 'calcTokens', tokens: 12 }
    }
  )

  t.alike(request, {
    type: 'calcTokens',
    modelId: 'llm',
    text: 'Weather in Paris?',
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      }
    ]
  })
})

test('calcTokens rejects invalid input before RPC', async (t) => {
  let called = false
  let missingPromptError = ''
  await t.exception(() =>
    createCalcTokensCall({ modelId: 'llm' } as typeof params, undefined, async () => {
      called = true
      return { type: 'calcTokens', tokens: 1 }
    }).catch((error) => {
      missingPromptError = String(error)
      throw error
    })
  )
  t.ok(missingPromptError.includes('At least one prompt source is required'))
  t.absent(called)

  let attachmentError = ''
  await t.exception(() =>
    createCalcTokensCall(
      {
        modelId: 'llm',
        text: 'What is in this image?',
        history: [
          {
            role: 'user',
            content: 'Describe this image',
            attachments: [{ path: '/tmp/image.png' }]
          }
        ]
      },
      undefined,
      async () => {
        called = true
        return { type: 'calcTokens', tokens: 1 }
      }
    ).catch((error) => {
      attachmentError = String(error)
      throw error
    })
  )
  t.ok(attachmentError.includes('use completion() for attachments'))
  t.absent(called)

  await t.exception(() =>
    createCalcTokensCall(
      {
        modelId: 'llm',
        history: [{ role: 'user', content: [{ type: 'media', path: '/tmp/image.png' }] }]
      },
      undefined,
      async () => {
        called = true
        return { type: 'calcTokens', tokens: 1 }
      }
    )
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
