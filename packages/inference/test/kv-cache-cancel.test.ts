import test from 'brittle'
import { shouldCommitCachedTurn } from '@/plugins/builtin/llamacpp-completion/ops/kv-cache-state'

// -----------------------------------------------------------------------------
// `shouldCommitCachedTurn` decides whether a cached turn commits its save or
// rolls it back: aborted, empty, budget-truncated, and context-truncated turns
// must not leave a partial response in the cache.
//
// Cancel detection flows through the per-request `AbortSignal` from
// `RequestRegistry` (see `test/request-registry.test.ts`); commit/rollback
// semantics are covered by `test/kv-cache-session.test.ts`.
// -----------------------------------------------------------------------------

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
