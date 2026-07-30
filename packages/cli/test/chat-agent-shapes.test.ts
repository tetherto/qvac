import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  chatCompletionChunk,
  chatCompletionResponse
} from '../src/serve/adapters/openai/chat-shapes.js'
import { sdkToolCallsToOpenaiDeltas } from '../src/serve/adapters/openai/tool-calls.js'

describe('chat agent OpenAI shapes', () => {
  it('maps blocking SDK tool calls to OpenAI chat tool_calls', () => {
    const body = chatCompletionResponse({
      id: 'chatcmpl_test',
      created: 100,
      model: 'agent-model',
      text: '',
      toolCalls: [{ id: 'call_weather', name: 'get_weather', arguments: { location: 'Tokyo' } }],
      completionTokens: 3,
      finishReason: 'tool_calls'
    })

    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0]!.finish_reason, 'tool_calls')
    assert.equal(body.choices[0]!.message.content, null)

    const toolCall = body.choices[0]!.message.tool_calls![0]!
    assert.equal(toolCall.id, 'call_weather')
    assert.equal(toolCall.type, 'function')
    assert.equal(toolCall.function.name, 'get_weather')
    assert.deepEqual(JSON.parse(toolCall.function.arguments) as unknown, { location: 'Tokyo' })
  })

  it('emits JSON-serializable streaming tool-call deltas', () => {
    const deltas =
      sdkToolCallsToOpenaiDeltas([
        { id: 'call_weather', name: 'get_weather', arguments: { location: 'Tokyo' } }
      ]) ?? []
    const toolChunk = chatCompletionChunk({
      id: 'chatcmpl_stream',
      created: 100,
      model: 'agent-model',
      delta: { tool_calls: deltas },
      finishReason: null
    })
    const doneChunk = chatCompletionChunk({
      id: 'chatcmpl_stream',
      created: 100,
      model: 'agent-model',
      delta: {},
      finishReason: 'tool_calls'
    })

    const serialized = [toolChunk, doneChunk].map(
      (chunk) => JSON.parse(JSON.stringify(chunk)) as typeof chunk
    )
    const toolCall = serialized[0]!.choices[0]!.delta.tool_calls![0]!

    assert.equal(serialized[0]!.object, 'chat.completion.chunk')
    assert.equal(serialized[0]!.choices[0]!.finish_reason, null)
    assert.equal(toolCall.index, 0)
    assert.equal(toolCall.id, 'call_weather')
    assert.equal(toolCall.function.name, 'get_weather')
    assert.deepEqual(JSON.parse(toolCall.function.arguments) as unknown, { location: 'Tokyo' })
    assert.equal(serialized[1]!.choices[0]!.finish_reason, 'tool_calls')
  })
})
