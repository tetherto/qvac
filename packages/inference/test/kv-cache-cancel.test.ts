import test from 'brittle'
import {
  decideCachedHistorySlice,
  type HistoryMessage,
  shouldCommitCachedTurn
} from '@/plugins/builtin/llamacpp-completion/ops/kv-cache-state'

// -----------------------------------------------------------------------------
// Unit-level regression coverage for `decideCachedHistorySlice` — the pure
// piece of the kv-cache cancel/zero-token fix (QVAC-17780). It guards the
// "stale savedCount → empty payload" failure mode.
//
// Cancel detection flows through the per-request `AbortSignal` from
// `RequestRegistry` (see `test/request-registry.test.ts`); the saved counts
// live in `kv-cache-session.ts`, whose commit/rollback semantics are covered
// by `test/kv-cache-session.test.ts`.
// -----------------------------------------------------------------------------

test('decideCachedHistorySlice: baseline slice when savedCount is valid', (t) => {
  const history: HistoryMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' }
  ]
  const { messages, clearStaleCount } = decideCachedHistorySlice(2, history)
  t.alike(messages, [
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' }
  ])
  t.is(clearStaleCount, false)
})

test('decideCachedHistorySlice: stale count (slice would be empty) falls back and flags clear', (t) => {
  const history: HistoryMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'user', content: 'u2' }
  ]
  const { messages, clearStaleCount } = decideCachedHistorySlice(3, history)
  t.alike(messages, history, 'the whole history goes, system message included')
  t.is(clearStaleCount, true, 'caller must be told to clear the stale savedCount')
})

test('decideCachedHistorySlice: savedCount > history.length falls back and flags clear', (t) => {
  const history: HistoryMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' }
  ]
  const { messages, clearStaleCount } = decideCachedHistorySlice(10, history)
  t.alike(messages, history, 'the whole history goes, system message included')
  t.is(clearStaleCount, true)
})

test('decideCachedHistorySlice: savedCount = 0 sends the whole history, no clear', (t) => {
  const history: HistoryMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' }
  ]
  const { messages, clearStaleCount } = decideCachedHistorySlice(0, history)
  t.alike(messages, history, 'nothing is cached to leave out')
  t.is(clearStaleCount, false)
})

test('decideCachedHistorySlice: empty history returns empty, no clear', (t) => {
  const { messages, clearStaleCount } = decideCachedHistorySlice(2, [])
  t.alike(messages, [])
  t.is(clearStaleCount, false)
})

test('decideCachedHistorySlice: savedCount = history.length slices to [] and flags clear', (t) => {
  // Exact shape of the reported QVAC-17780 bug: a cancelled turn records
  // `history.length + 1` for a 2-message history; the user's next turn
  // has 3 messages and a savedCount of 3 — slicing yields []. The
  // fallback must fire.
  const history: HistoryMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'user', content: 'u2' }
  ]
  const { messages, clearStaleCount } = decideCachedHistorySlice(history.length, history)
  t.alike(messages, history, 'the whole history goes, system message included')
  t.is(clearStaleCount, true)
})

test('regression: an externally-seeded stale savedCount still triggers the fallback', (t) => {
  // Belt-and-suspenders test: simulate an externally-poisoned savedCount
  // (e.g. from a pre-upgrade instance still running in memory) and
  // confirm that `decideCachedHistorySlice` refuses to emit an empty
  // payload and also flags the stale count for cleanup.
  //
  // The `cachedMessageCounts` map is private to `kv-cache-session.ts`,
  // so this regression is exercised by feeding the poisoned count into
  // the pure helper directly — the same surface the session calls.
  const savedCount = 3
  const history: HistoryMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'user', content: 'u2' }
  ]
  const { messages, clearStaleCount } = decideCachedHistorySlice(savedCount, history)

  t.alike(messages, history, 'the whole history goes, system message included')
  t.is(clearStaleCount, true, 'must prompt caller to clean up the stale count')
})

test('shouldCommitCachedTurn: completed turn with tokens commits', (t) => {
  t.is(
    shouldCommitCachedTurn({
      aborted: false,
      producedTokens: true,
      generatedTokens: 12,
      predict: 64,
      stoppedAtContextBoundary: false
    }),
    true
  )
})

test('shouldCommitCachedTurn: token-budget stop rolls back', (t) => {
  t.is(
    shouldCommitCachedTurn({
      aborted: false,
      producedTokens: true,
      generatedTokens: 64,
      predict: 64,
      stoppedAtContextBoundary: false
    }),
    false
  )
})

test('shouldCommitCachedTurn: context-boundary stop rolls back', (t) => {
  t.is(
    shouldCommitCachedTurn({
      aborted: false,
      producedTokens: true,
      generatedTokens: 12,
      predict: -2,
      stoppedAtContextBoundary: true
    }),
    false
  )
})

test('shouldCommitCachedTurn: unlimited prediction does not imply truncation', (t) => {
  t.is(
    shouldCommitCachedTurn({
      aborted: false,
      producedTokens: true,
      generatedTokens: 64,
      predict: -1,
      stoppedAtContextBoundary: false
    }),
    true
  )
})

test('shouldCommitCachedTurn: aborted or empty turns roll back', (t) => {
  t.is(
    shouldCommitCachedTurn({
      aborted: true,
      producedTokens: true,
      generatedTokens: 12,
      predict: 64,
      stoppedAtContextBoundary: false
    }),
    false
  )
  t.is(
    shouldCommitCachedTurn({
      aborted: false,
      producedTokens: false,
      generatedTokens: 0,
      predict: 64,
      stoppedAtContextBoundary: false
    }),
    false
  )
})
