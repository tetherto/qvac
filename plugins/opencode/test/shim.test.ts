import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  flattenContent,
  flattenMessages,
  makeThinkSplitter,
  transformSSEChunk,
  type SSEChunk
} from '../src/shim.ts'

test('flattenContent leaves strings and nullish untouched', () => {
  assert.equal(flattenContent('hello'), 'hello')
  assert.equal(flattenContent(null), null)
  assert.equal(flattenContent(undefined), undefined)
})

test('flattenContent concatenates text parts and drops non-text parts', () => {
  const parts = [
    { type: 'text', text: 'Hello ' },
    { type: 'text', text: 'world' },
    { type: 'image_url', image_url: { url: 'data:...' } }
  ]
  assert.equal(flattenContent(parts), 'Hello world')
})

test('flattenMessages flattens every message content in place', () => {
  const body = {
    model: 'qwen3.5-9b',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: 'plain' }
    ]
  }
  const out = flattenMessages(body)
  assert.equal(out.messages?.[0]?.content, 'sys')
  assert.equal(out.messages?.[1]?.content, 'plain')
})

test('think splitter routes inner text to reasoning and strips tags', () => {
  const split = makeThinkSplitter()
  const out = split('<think>reasoning</think>answer')
  assert.equal(out.reasoning, 'reasoning')
  assert.equal(out.content, 'answer')
})

test('think splitter handles a tag split across chunk boundaries', () => {
  const split = makeThinkSplitter()
  const a = split('before <thi')
  assert.equal(a.content, 'before ')
  assert.equal(a.reasoning, '')
  const b = split('nk>secret')
  assert.equal(b.content, '')
  assert.equal(b.reasoning, 'secret')
  const c = split(' more</think>tail')
  assert.equal(c.reasoning, ' more')
  assert.equal(c.content, 'tail')
})

test('think splitter flushes a final partial tag as content', () => {
  const split = makeThinkSplitter()
  const out = split('answer <thi')
  assert.equal(out.content, 'answer ')
  assert.equal(out.reasoning, '')
  assert.deepEqual(split.flush(), { content: '<thi', reasoning: '' })
})

test('think splitter flushes unfinished reasoning at stream end', () => {
  const split = makeThinkSplitter()
  const out = split('<think>reasoning')
  assert.equal(out.content, '')
  assert.equal(out.reasoning, 'reasoning')
  assert.deepEqual(split.flush(), { content: '', reasoning: '' })
})

test('transformSSEChunk emits a reasoning chunk then a content chunk', () => {
  const split = makeThinkSplitter()
  const chunk: SSEChunk = {
    id: 'x',
    choices: [{ index: 0, delta: { content: '<think>why</think>hi' } }]
  }
  const out = transformSSEChunk(chunk, split)
  assert.equal(out.length, 2)
  assert.equal(
    (out[0]?.choices?.[0]?.delta as { reasoning_content?: string }).reasoning_content,
    'why'
  )
  assert.equal((out[1]?.choices?.[0]?.delta as { content?: string }).content, 'hi')
})

test('transformSSEChunk passes through chunks without a string content delta', () => {
  const split = makeThinkSplitter()
  const roleChunk: SSEChunk = { choices: [{ index: 0, delta: { role: 'assistant' } }] }
  assert.deepEqual(transformSSEChunk(roleChunk, split), [roleChunk])

  const finishChunk: SSEChunk = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  assert.deepEqual(transformSSEChunk(finishChunk, split), [finishChunk])
})

test('transformSSEChunk preserves tool_calls deltas alongside emptied content', () => {
  const split = makeThinkSplitter()
  const chunk: SSEChunk = {
    choices: [{ index: 0, delta: { content: '', tool_calls: [{ index: 0, id: 't1' }] } }]
  }
  const out = transformSSEChunk(chunk, split)
  assert.equal(out.length, 1)
  assert.ok((out[0]?.choices?.[0]?.delta as { tool_calls?: unknown[] }).tool_calls)
})
