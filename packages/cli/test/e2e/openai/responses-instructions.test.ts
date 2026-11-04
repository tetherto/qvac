import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import type { CompletionEvent, CompletionRun } from '@qvac/sdk'
import { createServer } from '../helpers/server.js'

interface HistoryTurn {
  role: string
  content: string
  toolCalls?: Array<{ id?: string; name: string }>
}

// Captures the history each request hands the model; every reply calls `shell`.
async function capturingServer(t: TestContext) {
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
    const call = { id: `call_${histories.length}`, name: 'shell', arguments: { command: ['ls'] } }
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
})
