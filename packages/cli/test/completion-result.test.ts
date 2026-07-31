import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CompletionRun, CompletionStats, ToolCall } from '@qvac/sdk'
import { InferenceCancelledError } from '@qvac/sdk'
import {
  drainCompletion,
  completionTokensFromStats
} from '../src/serve/adapters/openai/completion-result.js'
import { HttpError } from '../src/serve/lib/http-error.js'

function fakeRun(opts: {
  tokens?: string[]
  thinking?: string[]
  toolCalls?: ToolCall[]
  stats?: CompletionStats
  stopReason?: string
  final?: Promise<unknown>
}): CompletionRun {
  async function* events(): AsyncGenerator<unknown> {
    let seq = 0
    for (const t of opts.thinking ?? []) yield { type: 'thinkingDelta', seq: seq++, text: t }
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
    tokenStream: (async function* (): AsyncGenerator<string> {})(),
    toolCallStream: (async function* (): AsyncGenerator<never> {})()
  }
}

describe('completionTokensFromStats', () => {
  it('prefers delivered content/thinking pieces over stats.generatedTokens', () => {
    assert.equal(completionTokensFromStats('a b c', { generatedTokens: 256 }, 113), 113)
    assert.equal(completionTokensFromStats('', { generatedTokens: 512 }, 0), 512)
  })

  it('prefers finite stats.generatedTokens when nothing was delivered', () => {
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
    const r = await drainCompletion(
      fakeRun({
        toolCalls: [{ id: 'c1', name: 'fn', arguments: {} }],
        stopReason: 'length'
      })
    )
    assert.equal(r.finishReason, 'tool_calls')
    assert.equal(r.toolCalls.length, 1)
  })

  it('completion tokens match delivered deltas, not an inflated predict-cap stats value', async () => {
    const r = await drainCompletion(
      fakeRun({ tokens: ['a', 'b'], stats: { generatedTokens: 256 } })
    )
    assert.equal(r.completionTokens, 2)
  })

  it('counts thinking deltas toward completion tokens with content', async () => {
    const r = await drainCompletion(
      fakeRun({
        thinking: ['reason1', 'reason2', 'reason3'],
        tokens: ['ans'],
        stats: { generatedTokens: 512 }
      })
    )
    assert.equal(r.completionTokens, 4)
    assert.equal(r.thinking, 'reason1reason2reason3')
  })

  it('reports thinking-only delivery when content is empty (not the predict cap)', async () => {
    const r = await drainCompletion(
      fakeRun({
        thinking: Array.from({ length: 7 }, (_, i) => `t${i}`),
        tokens: [],
        stats: { generatedTokens: 512 }
      })
    )
    assert.equal(r.text, '')
    assert.equal(r.completionTokens, 7)
  })

  it('completion tokens use stats when no content or thinking deltas were delivered', async () => {
    const r = await drainCompletion(fakeRun({ tokens: [], stats: { generatedTokens: 7 } }))
    assert.equal(r.completionTokens, 7)
  })

  it('completion tokens fall back to whitespace word count without stats or deltas', async () => {
    const r = await drainCompletion(fakeRun({ tokens: ['one two ', 'three'] }))
    // Two content deltas were delivered, so piece count wins over whitespace.
    assert.equal(r.completionTokens, 2)
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
      () =>
        drainCompletion(
          fakeRun({
            tokens: ['partial'],
            stopReason: 'cancelled',
            final: Promise.reject(cancelErr)
          })
        ),
      (err) => err instanceof InferenceCancelledError
    )
  })
})
