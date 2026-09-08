'use strict'

// The context-overflow recipe shared by `api-behavior.test.js` and
// `reasoning.test.js`.
//
// FILLER_WORDS must tokenize to just under CTX_SIZE so the prompt is accepted
// at prefill and generation is what fills the window. A chat-template change
// or a model pin bump can push it over, which silently turns the generation
// case into a second prefill rejection and leaves the stop-reason contract
// untested. It lives here so that recalibration happens once, not twice.
//
// The two prefill guards report different quantities and the SDK's overflow
// parser matches each wording separately, so the assertions pin the wording
// rather than a generic /context overflow/ that both guards satisfy.

const CTX_SIZE = 512

// Sized to land just inside CTX_SIZE once the chat template wraps it.
const FILLER_WORDS = 430

// Just past CTX_SIZE, not many times over: the guard compares against the
// window either way, and darwin-x64 Metal fails its NEXT decode after
// tokenizing a prompt eight times the context. That lands on the recovery turn
// as `command buffer 0 failed with status 5`, pointing away from the cause.
const OVERSIZED_WORDS = 600

// Far larger than the room the filler leaves, so the stop is always the
// context and never the prediction cap.
const PREDICT = 512

// The window is already full, so the follow-up only has to be non-empty.
const CACHED_FOLLOW_UP = 'And then what happened?'

function fillerPrompt() {
  return `${'word '.repeat(FILLER_WORDS)}\nNow repeat the word "again" over and over without stopping.`
}

function oversizedPrompt() {
  return 'word '.repeat(OVERSIZED_WORDS)
}

// `generatedTokens < PREDICT` is what proves the prediction cap was not the
// stopper.
function assertStoppedByFullContext(t, stats, output) {
  t.is(
    stats && stats.stopReason,
    'contextOverflow',
    `a generation that fills the window reports it (stats=${JSON.stringify(stats)})`
  )
  t.ok(output.length > 0, 'a generation stopped by a full context still returns its tokens')
  t.ok(
    Number(stats && stats.generatedTokens) < PREDICT,
    `the stop was the context, not the prediction cap (generatedTokens=${stats && stats.generatedTokens}, predict=${PREDICT})`
  )
}

// First prefill guard: the prompt does not fit on its own, so the message
// reports prompt tokens alone.
function assertPromptAloneRejected(t, err) {
  const message = (err && err.message) || String(err)
  t.ok(err, 'a prompt larger than the context window is rejected')
  t.ok(/context overflow/i.test(message), `the rejection says the context is full, got: ${message}`)
  t.ok(
    /prompt tokens \d+[,\s]+max context tokens \d+/i.test(message),
    `the rejection reports prompt tokens against the window, got: ${message}`
  )
}

// Second prefill guard: the prompt would fit in an empty window but not on top
// of the cache. Reached only when `nPast_` is non-zero, so a turn must have
// been cached first.
function assertCachedFollowUpRejected(t, err) {
  const message = (err && err.message) || String(err)
  t.ok(err, 'a follow-up that no longer fits beside the cache is rejected')
  t.ok(/context overflow/i.test(message), `the rejection says the context is full, got: ${message}`)
  t.ok(
    /cached tokens \d+ plus prompt tokens \d+ exceeds? the max context tokens \d+/i.test(message),
    `the rejection names the cached tokens it counted, got: ${message}`
  )
}

module.exports = {
  CTX_SIZE,
  FILLER_WORDS,
  OVERSIZED_WORDS,
  PREDICT,
  CACHED_FOLLOW_UP,
  fillerPrompt,
  oversizedPrompt,
  assertStoppedByFullContext,
  assertPromptAloneRejected,
  assertCachedFollowUpRejected
}
