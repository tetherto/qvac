import test from 'brittle'
import { z } from 'zod'
import { createBatchCompletionRun } from '@/client/api/batch-completion'
import type { BatchCompletionStreamRequest } from '@/schemas'
import { CompletionFailedError, InferenceCancelledError } from '@/utils/errors-server'

async function* mockResponses(responses: unknown[]): AsyncGenerator<unknown> {
  for (const response of responses) yield response
}

async function collect<T>(events: AsyncIterable<T>) {
  const collected: T[] = []
  for await (const event of events) collected.push(event)
  return collected
}

function createRun(responses: unknown[]) {
  return createBatchCompletionRun(
    {
      modelId: 'llama',
      prompts: [
        { id: 'a', history: [{ role: 'user', content: 'A' }] },
        { id: 'b', history: [{ role: 'user', content: 'B' }] }
      ]
    },
    function streamFactory() {
      return mockResponses(responses)
    }
  )
}

test('batchCompletion client: byId is memoized and replays per-id events', async (t) => {
  const run = createRun([
    {
      type: 'batchCompletionStream',
      ids: ['a', 'b'],
      events: []
    },
    {
      type: 'batchCompletionStream',
      events: [
        { id: 'a', event: { type: 'contentDelta', seq: 0, text: 'A' } },
        { id: 'b', event: { type: 'contentDelta', seq: 0, text: 'B' } }
      ]
    },
    {
      type: 'batchCompletionStream',
      done: true,
      ids: ['a', 'b'],
      events: [
        { id: 'a', event: { type: 'completionDone', seq: 1 } },
        { id: 'b', event: { type: 'completionDone', seq: 1 } }
      ],
      stats: { avgConcurrentSeq: 2, generatedTokens: 2 }
    }
  ])

  const firstA = run.byId('a')
  const secondA = run.byId('a')
  t.is(firstA, secondA, 'repeated byId calls return the same sub-run')

  const aEventsPromise = collect(firstA.events)
  const flatEvents = await collect(run.events)
  const ids = await run.ids
  const results = await run.results
  const aEvents = await aEventsPromise

  t.alike(ids, ['a', 'b'])
  t.is(flatEvents.length, 4, 'flat stream sees every id-tagged event')
  t.alike(
    results.map((result) => `${result.id}:${result.final.contentText}`),
    ['a:A', 'b:B']
  )
  t.alike(
    aEvents.map((event) => event.type),
    ['contentDelta', 'completionDone'],
    'per-id stream only includes events for that id'
  )

  const lateB = run.byId('b')
  const bEvents = await collect(lateB.events)
  const bFinal = await lateB.final
  t.alike(
    bEvents.map((event) => event.type),
    ['contentDelta', 'completionDone'],
    'late byId calls replay accumulated events'
  )
  t.is(bFinal.contentText, 'B')

  let rejectedUnknown = false
  try {
    await run.byId('missing').final
  } catch (error) {
    rejectedUnknown = error instanceof CompletionFailedError
  }
  t.ok(rejectedUnknown, 'late unknown ids reject instead of hanging')
})

test('batchCompletion client: cancelled done rejects results and stats', async (t) => {
  const run = createRun([
    {
      type: 'batchCompletionStream',
      ids: ['a', 'b'],
      events: []
    },
    {
      type: 'batchCompletionStream',
      done: true,
      ids: ['a', 'b'],
      events: [
        {
          id: 'a',
          event: {
            type: 'completionDone',
            seq: 0,
            stopReason: 'cancelled'
          }
        },
        {
          id: 'b',
          event: {
            type: 'completionDone',
            seq: 0,
            stopReason: 'cancelled'
          }
        }
      ]
    }
  ])

  await collect(run.events)
  const settled = await Promise.allSettled([run.results, run.stats, run.byId('a').final])

  for (const outcome of settled) {
    t.is(outcome.status, 'rejected')
    if (outcome.status === 'rejected') {
      t.ok(outcome.reason instanceof InferenceCancelledError)
    }
  }
})

test('batchCompletion client: stream errors reject existing and late byId finals', async (t) => {
  async function* failingResponses(): AsyncGenerator<unknown> {
    yield { type: 'batchCompletionStream', ids: ['a', 'b'], events: [] }
    throw new Error('stream failed')
  }

  const run = createBatchCompletionRun(
    {
      modelId: 'llama',
      prompts: [
        { id: 'a', history: [{ role: 'user', content: 'A' }] },
        { id: 'b', history: [{ role: 'user', content: 'B' }] }
      ]
    },
    function streamFactory() {
      return failingResponses()
    }
  )
  const earlyA = run.byId('a')

  let resultsRejected = false
  try {
    await run.results
  } catch (error) {
    resultsRejected = error instanceof Error && error.message === 'stream failed'
  }
  t.ok(resultsRejected, 'results reject with the stream error')

  for (const final of [earlyA.final, run.byId('b').final]) {
    let finalRejected = false
    try {
      await final
    } catch (error) {
      finalRejected = error instanceof Error && error.message === 'stream failed'
    }
    t.ok(finalRejected, 'byId final rejects with the stream error')
  }
})

test('batchCompletion client: preserves multimodal attachments in stream request', async (t) => {
  let capturedRequest: BatchCompletionStreamRequest | undefined
  const run = createBatchCompletionRun(
    {
      modelId: 'vision',
      prompts: [
        {
          id: 'image',
          history: [
            {
              role: 'user',
              content: 'What animal is in this image?',
              attachments: [{ path: '/tmp/elephant.jpg' }]
            }
          ]
        }
      ]
    },
    function streamFactory(request) {
      capturedRequest = request
      return mockResponses([
        {
          type: 'batchCompletionStream',
          done: true,
          ids: ['image'],
          events: [
            {
              id: 'image',
              event: { type: 'completionDone', seq: 0 }
            }
          ]
        }
      ])
    }
  )

  await collect(run.events)
  t.ok(capturedRequest, 'request was sent')
  if (!capturedRequest) return
  t.alike(capturedRequest.prompts[0]?.history[0]?.attachments, [{ path: '/tmp/elephant.jpg' }])
})

test('batchCompletion client: resolves per-prompt tools and routes handlers by id', async (t) => {
  let capturedRequest: BatchCompletionStreamRequest | undefined
  const calls: string[] = []

  const run = createBatchCompletionRun(
    {
      modelId: 'llama',
      prompts: [
        {
          id: 'inline',
          history: [{ role: 'user', content: 'Call inline tool' }],
          tools: [
            {
              name: 'inline_tool',
              description: 'Inline test tool',
              parameters: z.object({
                city: z.string()
              }),
              handler: async function (args) {
                calls.push(`inline:${args['city']}`)
                return { source: 'inline', args }
              }
            }
          ]
        },
        {
          id: 'mcp',
          history: [{ role: 'user', content: 'Call MCP tool' }],
          mcp: [
            {
              client: {
                listTools: async function () {
                  return {
                    tools: [
                      {
                        name: 'mcp_tool',
                        description: 'MCP test tool',
                        inputSchema: {
                          type: 'object',
                          properties: {
                            query: { type: 'string' }
                          },
                          required: ['query']
                        }
                      }
                    ]
                  }
                },
                callTool: async function (params) {
                  calls.push(`mcp:${params.arguments['query']}`)
                  return { source: 'mcp', params }
                }
              },
              includeResources: false
            }
          ]
        },
        {
          id: 'plain',
          history: [{ role: 'user', content: 'No tools here' }]
        }
      ]
    },
    function streamFactory(request) {
      capturedRequest = request
      return mockResponses([
        {
          type: 'batchCompletionStream',
          ids: ['inline', 'mcp', 'plain'],
          events: []
        },
        {
          type: 'batchCompletionStream',
          done: true,
          ids: ['inline', 'mcp', 'plain'],
          events: [
            {
              id: 'inline',
              event: {
                type: 'toolCall',
                seq: 0,
                call: {
                  id: 'call-inline',
                  name: 'inline_tool',
                  arguments: { city: 'Tokyo' }
                }
              }
            },
            {
              id: 'inline',
              event: { type: 'completionDone', seq: 1 }
            },
            {
              id: 'mcp',
              event: {
                type: 'toolCall',
                seq: 0,
                call: {
                  id: 'call-mcp',
                  name: 'mcp_tool',
                  arguments: { query: 'weather' }
                }
              }
            },
            {
              id: 'mcp',
              event: { type: 'completionDone', seq: 1 }
            },
            {
              id: 'plain',
              event: {
                type: 'toolCall',
                seq: 0,
                call: {
                  id: 'call-plain',
                  name: 'inline_tool',
                  arguments: { city: 'Paris' }
                }
              }
            },
            {
              id: 'plain',
              event: { type: 'completionDone', seq: 1 }
            }
          ]
        }
      ])
    }
  )

  await collect(run.events)
  t.ok(capturedRequest, 'request was sent')
  if (!capturedRequest) return

  t.is(capturedRequest.prompts[0]?.tools?.[0]?.name, 'inline_tool')
  t.is(capturedRequest.prompts[1]?.tools?.[0]?.name, 'mcp_tool')
  t.is(capturedRequest.prompts[2]?.tools, undefined)

  const inlineFinal = await run.byId('inline').final
  const mcpFinal = await run.byId('mcp').final
  const plainFinal = await run.byId('plain').final

  t.ok(inlineFinal.toolCalls[0]?.invoke, 'inline handler attached')
  t.ok(mcpFinal.toolCalls[0]?.invoke, 'mcp handler attached')
  t.absent(plainFinal.toolCalls[0]?.invoke, 'plain prompt has no handler')

  const inlineResult = await inlineFinal.toolCalls[0]?.invoke?.()
  const mcpResult = await mcpFinal.toolCalls[0]?.invoke?.()

  t.alike(inlineResult, {
    source: 'inline',
    args: { city: 'Tokyo' }
  })
  t.alike(mcpResult, {
    source: 'mcp',
    params: { name: 'mcp_tool', arguments: { query: 'weather' } }
  })
  t.alike(calls, ['inline:Tokyo', 'mcp:weather'])
})

test('batchCompletion client: routes handlers by position when ids are omitted', async (t) => {
  const calls: string[] = []

  const run = createBatchCompletionRun(
    {
      modelId: 'llama',
      prompts: [
        {
          history: [{ role: 'user', content: 'Call inline tool' }],
          tools: [
            {
              name: 'inline_tool',
              description: 'Inline test tool',
              parameters: z.object({ city: z.string() }),
              handler: async function (args) {
                calls.push(`inline:${args['city']}`)
                return { source: 'inline', args }
              }
            }
          ]
        },
        {
          history: [{ role: 'user', content: 'No tools here' }]
        }
      ]
    },
    function streamFactory() {
      return mockResponses([
        {
          type: 'batchCompletionStream',
          ids: ['batch-1', 'batch-2'],
          events: []
        },
        {
          type: 'batchCompletionStream',
          done: true,
          ids: ['batch-1', 'batch-2'],
          events: [
            {
              id: 'batch-1',
              event: {
                type: 'toolCall',
                seq: 0,
                call: {
                  id: 'call-inline',
                  name: 'inline_tool',
                  arguments: { city: 'Tokyo' }
                }
              }
            },
            { id: 'batch-1', event: { type: 'completionDone', seq: 1 } },
            { id: 'batch-2', event: { type: 'completionDone', seq: 0 } }
          ]
        }
      ])
    }
  )

  await collect(run.events)

  t.alike(await run.ids, ['batch-1', 'batch-2'], 'addon-minted ids surface')

  const toolPromptFinal = await run.byId('batch-1').final
  const plainPromptFinal = await run.byId('batch-2').final

  t.ok(
    toolPromptFinal.toolCalls[0]?.invoke,
    'handler routed to the first prompt by position despite the minted id'
  )
  t.absent(plainPromptFinal.toolCalls[0]?.invoke, 'second prompt has no handler')

  await toolPromptFinal.toolCalls[0]?.invoke?.()
  t.alike(calls, ['inline:Tokyo'])
})
