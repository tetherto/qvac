import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CompletionRun, CompletionStats, ToolCall, ToolCallError } from '@qvac/sdk'
import { InferenceCancelledError } from '@qvac/sdk'
import {
  drainCompletion,
  completionTokensFromStats,
  formatToolErrors
} from '@/serve/extensions/openai/adapters/completion-result'
import { HttpError } from '@/serve/lib/http-error'

function fakeRun(opts: {
  tokens?: string[]
  toolCalls?: ToolCall[]
  toolErrors?: ToolCallError[]
  stats?: CompletionStats
  stopReason?: string
  final?: Promise<unknown>
}): CompletionRun {
  async function* events(): AsyncGenerator<unknown> {
    let seq = 0
    for (const t of opts.tokens ?? []) yield { type: 'contentDelta', seq: seq++, text: t }
    for (const call of opts.toolCalls ?? []) yield { type: 'toolCall', seq: seq++, call }
    for (const error of opts.toolErrors ?? []) yield { type: 'toolError', seq: seq++, error }
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
  it('prefers emittedTokens over inflated generatedTokens', () => {
    assert.equal(
      completionTokensFromStats('a b c', { generatedTokens: 256, emittedTokens: 113 }),
      113
    )
    assert.equal(completionTokensFromStats('', { generatedTokens: 512, emittedTokens: 0 }), 0)
  })

  it('prefers finite stats.generatedTokens when emittedTokens is absent', () => {
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

  it('completion tokens prefer emittedTokens over inflated generatedTokens', async () => {
    const r = await drainCompletion(
      fakeRun({
        tokens: ['a', 'b'],
        stats: { generatedTokens: 256, emittedTokens: 2 }
      })
    )
    assert.equal(r.completionTokens, 2)
  })

  it('does not treat contentDelta event counts as tokens', async () => {
    const r = await drainCompletion(
      fakeRun({
        tokens: ['Hello, world!'],
        stats: { generatedTokens: 512, emittedTokens: 4 }
      })
    )
    assert.equal(r.completionTokens, 4)
  })

  it('completion tokens use generatedTokens when emittedTokens is absent', async () => {
    const r = await drainCompletion(fakeRun({ tokens: [], stats: { generatedTokens: 7 } }))
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

describe('drainCompletion tool errors', () => {
  it('collects toolError events alongside successful calls', async () => {
    const drained = await drainCompletion(
      fakeRun({
        toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Lugano' } }],
        toolErrors: [{ code: 'PARSE_ERROR', message: 'bad json', raw: '{' }]
      })
    )
    assert.deepEqual(drained.toolErrors, [{ code: 'PARSE_ERROR', message: 'bad json', raw: '{' }])
    assert.equal(drained.toolCalls.length, 1)
    assert.equal(drained.finishReason, 'tool_calls')
  })

  // Every tool call failing leaves no calls and no content, so finish_reason is
  // the ordinary 'stop' -- the log line is the only signal the model tried.
  it('reports stop when every tool call failed to parse', async () => {
    const drained = await drainCompletion(
      fakeRun({
        toolErrors: [
          { code: 'PARSE_ERROR', message: 'bad json' },
          { code: 'VALIDATION_ERROR', message: 'city must be a string' }
        ]
      })
    )
    assert.equal(drained.toolErrors.length, 2)
    assert.equal(drained.toolCalls.length, 0)
    assert.equal(drained.finishReason, 'stop')
  })

  it('leaves toolErrors empty on a clean run', async () => {
    const drained = await drainCompletion(fakeRun({ tokens: ['hi'] }))
    assert.deepEqual(drained.toolErrors, [])
  })
})

describe('formatToolErrors', () => {
  it('returns an empty string when there are none', () => {
    assert.equal(formatToolErrors([]), '')
  })

  it('counts errors and lists each distinct code once', () => {
    assert.equal(
      formatToolErrors([
        { code: 'PARSE_ERROR', message: 'a' },
        { code: 'PARSE_ERROR', message: 'b' },
        { code: 'UNKNOWN_TOOL', message: 'c' }
      ]),
      ' toolerrors=3 (PARSE_ERROR,UNKNOWN_TOOL)'
    )
  })
})
