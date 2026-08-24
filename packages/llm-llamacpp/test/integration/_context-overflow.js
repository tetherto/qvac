'use strict'

// One home for the context-overflow recipe that `api-behavior.test.js` and
// `reasoning.test.js` both drive.
//
// The sizing is tokenizer-sensitive. FILLER_WORDS must tokenize to just under
// CTX_SIZE so the prompt is accepted at prefill and generation is what fills
// the window. A chat-template change or a model pin bump can push it over,
// which would silently turn the generation case into a second prefill
// rejection and leave the stop-reason contract untested. Calibrating it once
// here means that recalibration happens in one place instead of two.
//
// The two prefill guards in `TextLlmContext::preparePrefill` report different
// quantities and the SDK's overflow parser matches each wording separately, so
// the assertions below pin the wording rather than a generic /context
// overflow/ that both guards satisfy.

const CTX_SIZE = 512

// Sized to land just inside CTX_SIZE once the chat template wraps it.
const FILLER_WORDS = 430

// Sized just past CTX_SIZE rather than many times over it: the guard compares
// against the window, so 600 tokens is as deterministic as 4000, and the
// darwin-x64 Metal backend fails its NEXT decode after tokenizing a prompt
// eight times the context. That failure lands on the recovery turn with
// `command buffer 0 failed with status 5`, pointing away from what caused it.
const OVERSIZED_WORDS = 600

// Far larger than the room the filler leaves, so the stop is always the
// context and never the prediction cap.
const PREDICT = 512

// The window is already full of cached conversation, so the follow-up only has
// to be small and non-empty to tip it over.
const CACHED_FOLLOW_UP = 'And then what happened?'

function fillerPrompt() {
  return `${'word '.repeat(FILLER_WORDS)}\nNow repeat the word "again" over and over without stopping.`
}

function oversizedPrompt() {
  return 'word '.repeat(OVERSIZED_WORDS)
}

// A generation that fills the window stops with `contextOverflow` and still
// hands back what it produced. `generatedTokens < PREDICT` is what proves the
// prediction cap was not the stopper.
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

// First prefill guard: the prompt does not fit on its own, so the cache is not
// part of the arithmetic and the message reports prompt tokens alone.
function assertPromptAloneRejected(t, err) {
  const message = (err && err.message) || String(err)
  t.ok(err, 'a prompt larger than the context window is rejected')
  t.ok(/context overflow/i.test(message), `the rejection says the context is full, got: ${message}`)
  t.ok(
    /prompt tokens \d+[,\s]+max context tokens \d+/i.test(message),
    `the rejection reports prompt tokens against the window, got: ${message}`
  )
}

// Second prefill guard: the prompt would fit in an empty window, but not on
// top of what is already cached. Reached only when `nPast_` is non-zero, so a
// turn must have been cached first.
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
