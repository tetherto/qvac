import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import type { CompletionEvent, CompletionRun } from '@qvac/sdk'
import { createServer } from '../helpers/server.js'

interface HistoryTurn {
  role: string
  content: string
  toolCalls?: Array<{ id?: string; name: string }>
}

type ToolCallReply = { name: string; arguments: Record<string, unknown> }

// Captures the history each request hands the model; each reply calls the tool
// `nextCall` picks for that turn (`shell` by default).
async function capturingServer(
  t: TestContext,
  nextCall: (turn: number) => ToolCallReply = () => ({
    name: 'shell',
    arguments: { command: ['ls'] }
  })
) {
  const app = await createServer(t, {
    extensions: ['openai'],
    config: {
      serve: {
        models: {
          chat: {
            type: 'llamacpp-completion',
            src: 'hyper://example.invalid/chat',
            preload: false,
            config: { tools: true }
          }
        }
      }
    }
  })
  app.addHook('onRequest', (req, _reply, done) => {
    req.bindCancel = () => {}
    done()
  })
  await app.ready()
  app.qvac.registry.register('chat', app.qvac.serveConfig.models.get('chat')!)
  app.qvac.registry.setReady('chat', 'sdk-chat')

  const histories: HistoryTurn[][] = []
  app.qvac.extensions.openai!.completionOverride = (params) => {
    histories.push(params.history as HistoryTurn[])
    const call = { id: `call_${histories.length}`, ...nextCall(histories.length) }
    async function* events(): AsyncGenerator<CompletionEvent> {
      yield { type: 'toolCall', seq: 0, call }
      yield { type: 'completionDone', seq: 1, stopReason: 'eos' }
    }
    const final = Promise.resolve({
      contentText: '',
      toolCalls: [call],
      raw: { fullText: '' },
      stopReason: 'eos'
    })
    return {
      requestId: 'instructions-request',
      events: events(),
      final,
      text: Promise.resolve(''),
      toolCalls: Promise.resolve([call]),
      stats: Promise.resolve(undefined),
      tokenStream: (async function* (): AsyncGenerator<string> {})(),
      toolCallStream: (async function* (): AsyncGenerator<never> {})()
    } as unknown as CompletionRun
  }
  return { app, histories }
}

const shellTool = {
  type: 'function',
  name: 'shell',
  parameters: { type: 'object', properties: { command: { type: 'array' } } }
}

function message(role: string, text: string) {
  return { type: 'message', role, content: [{ type: 'input_text', text }] }
}

describe('responses: instructions across stored turns', () => {
  it('sends one leading system turn when a chained request adds its own instructions', async (t) => {
    const { app, histories } = await capturingServer(t)
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: { model: 'chat', tools: [shellTool], ...payload }
      })

    const first = await post({
      instructions: 'You are a coding agent.',
      input: [message('developer', 'Use the shell tool.'), message('user', 'List the files.')],
      store: true
    })
    assert.equal(first.statusCode, 200, first.body)
    const firstBody = first.json() as any
    const call = firstBody.output.find((item: any) => item.type === 'function_call')

    const second = await post({
      instructions: 'You are a coding agent.',
      previous_response_id: firstBody.id,
      input: [
        message('developer', 'The sandbox is read-only.'),
        { type: 'function_call_output', call_id: call.call_id, output: 'README.md' }
      ]
    })
    assert.equal(second.statusCode, 200, second.body)
    assert.equal((second.json() as any).status, 'requires_action')

    const history = histories[1]!
    assert.deepEqual(
      history.map((turn) => turn.role),
      ['system', 'user', 'assistant', 'tool']
    )
    assert.equal(
      history[0]!.content,
      'Use the shell tool.\n\nYou are a coding agent.\n\nThe sandbox is read-only.'
    )
    assert.equal(history[2]!.toolCalls![0]!.name, 'shell')
  })

  it('returns 400 for a malformed namespace tool', async (t) => {
    const { app, histories } = await capturingServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'chat',
        input: 'hello',
        tools: [{ type: 'namespace', name: 'files', tools: [null] }]
      }
    })
    assert.equal(res.statusCode, 400, res.body)
    assert.equal((res.json() as any).error.code, 'invalid_tools')
    assert.equal(histories.length, 0)
  })

  it('finds a deferred namespaced tool through tool_search and returns its namespace', async (t) => {
    const { app, histories } = await capturingServer(t, (turn) =>
      turn === 1
        ? { name: 'tool_search', arguments: { query: 'read a file' } }
        : { name: 'files__read', arguments: { path: 'package.json' } }
    )
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'chat',
        input: 'What is in package.json?',
        tools: [
          {
            type: 'namespace',
            name: 'files',
            tools: [
              {
                type: 'function',
                name: 'read',
                description: 'Read a file.',
                defer_loading: true,
                parameters: { type: 'object', properties: { path: { type: 'string' } } }
              }
            ]
          }
        ]
      }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(histories.length, 2, 'a search round, then the answering round')
    const searchResult = histories[1]!.at(-1)!
    assert.equal(searchResult.role, 'tool')
    assert.ok(searchResult.content.includes('files__read'), searchResult.content)
    const call = (res.json() as any).output.find((item: any) => item.type === 'function_call')
    assert.deepEqual([call.namespace, call.name], ['files', 'read'])
  })
})
