import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CompletionRun, CompletionStats, ToolCall } from '@qvac/sdk'
import { InferenceCancelledError } from '@qvac/sdk'
import { drainCompletion, completionTokensFromStats } from '../src/serve/adapters/openai/completion-result.js'
import { HttpError } from '../src/serve/lib/http-error.js'

function fakeRun (opts: {
  tokens?: string[]
  toolCalls?: ToolCall[]
  stats?: CompletionStats
  stopReason?: string
  final?: Promise<unknown>
}): CompletionRun {
  async function * events (): AsyncGenerator<unknown> {
    let seq = 0
    for (const t of opts.tokens ?? []) yield { type: 'contentDelta', seq: seq++, text: t }
    for (const call of opts.toolCalls ?? []) yield { type: 'toolCall', seq: seq++, call }
    if (opts.stats !== undefined) yield { type: 'completionStats', seq: seq++, stats: opts.stats }
    yield { type: 'completionDone', seq: seq++, stopReason: opts.stopReason ?? 'eos' }
  }
  return {
    requestId: 'test-request-id',
    events: events() as unknown as CompletionRun['events'],
    final: (opts.final ?? Promise.resolve(undefined)) as unknown as CompletionRun['final'],
    text: Promise.resolve(''),
    toolCalls: Promise.resolve([]) as unknown as CompletionRun['toolCalls'],
    stats: Promise.resolve(opts.stats),
    tokenStream: (async function * empty (): AsyncGenerator<string> {})(),
    toolCallStream: (async function * empty (): AsyncGenerator<never> {})()
  }
}

describe('completionTokensFromStats', () => {
  it('prefers finite stats.generatedTokens', () => {
    assert.equal(completionTokensFromStats('a b c', { generatedTokens: 10 }), 10)
    assert.equal(completionTokensFromStats('a b c', { generatedTokens: 0 }), 0)
  })

  it('falls back to whitespace word count when stats absent or non-finite', () => {
    assert.equal(completionTokensFromStats('one two three', undefined), 3)
    assert.equal(completionTokensFromStats('one two three', { generatedTokens: Number.NaN }), 3)
    assert.equal(completionTokensFromStats('', undefined), 0)
  })
})

describe('drainCompletion', () => {
  it('accumulates content text and streams tokens via onToken', async () => {
    const seen: string[] = []
    const r = await drainCompletion(fakeRun({ tokens: ['Hel', 'lo'] }), (t) => seen.push(t))
    assert.equal(r.text, 'Hello')
    assert.deepEqual(seen, ['Hel', 'lo'])
  })

  it('finish_reason=stop on eos', async () => {
    const r = await drainCompletion(fakeRun({ tokens: ['hi'], stopReason: 'eos' }))
    assert.equal(r.finishReason, 'stop')
  })

  it('finish_reason=length when truncated', async () => {
    const r = await drainCompletion(fakeRun({ tokens: ['hi'], stopReason: 'length' }))
    assert.equal(r.finishReason, 'length')
    assert.equal(r.stopReason, 'length')
  })

  it('finish_reason=tool_calls takes precedence over length', async () => {
    const r = await drainCompletion(fakeRun({
      toolCalls: [{ id: 'c1', name: 'fn', arguments: {} }],
      stopReason: 'length'
    }))
    assert.equal(r.finishReason, 'tool_calls')
    assert.equal(r.toolCalls.length, 1)
  })

  it('completion tokens come from stats when present', async () => {
    const r = await drainCompletion(fakeRun({ tokens: ['a', 'b'], stats: { generatedTokens: 7 } }))
    assert.equal(r.completionTokens, 7)
  })

  it('completion tokens fall back to whitespace word count without stats', async () => {
    const r = await drainCompletion(fakeRun({ tokens: ['one two ', 'three'] }))
    assert.equal(r.completionTokens, 3)
  })

  it('throws HttpError(502) on errorDone', async () => {
    await assert.rejects(
      () => drainCompletion(fakeRun({ tokens: ['partial'], stopReason: 'error' })),
      (err) => err instanceof HttpError && err.status === 502 && err.code === 'inference_failed'
    )
  })

  it('throws InferenceCancelledError on cancelledDone', async () => {
    const cancelErr = new InferenceCancelledError('test-request-id')
    await assert.rejects(
      () => drainCompletion(fakeRun({
        tokens: ['partial'],
        stopReason: 'cancelled',
        final: Promise.reject(cancelErr)
      })),
      (err) => err instanceof InferenceCancelledError
    )
  })
})
