import test from 'brittle'
import { isAddonCancelledError } from '@/server/bare/plugins/llamacpp-completion/ops/batch-cancelled'

// The addon's structured-code format from
// `qvac_errors::StatusError::codeString()`:
// `"[ <addonId> :: <localCodeMsg> ]"`. Bare's `js_throw_error(env,
// code, msg)` sets this string on the JS Error's `.code`. The
// continuous-batching scheduler fails an overflow-cancelled batch group
// with `LlmErrors.hpp::Cancelled` → `"[ LLM :: Cancelled ]"`.
const ADDON_CODE = '[ LLM :: Cancelled ]'

test("isAddonCancelledError: detects addon's structured codeString", (t) => {
  const err = Object.assign(new Error('request cancelled before it could run'), {
    code: ADDON_CODE
  })
  t.is(isAddonCancelledError(err), true)
})

test("isAddonCancelledError: codeString anchored — sibling names don't match", (t) => {
  t.is(
    isAddonCancelledError(Object.assign(new Error('x'), { code: '[ LLM :: CancelledByPolicy ]' })),
    false
  )
  t.is(
    isAddonCancelledError(Object.assign(new Error('x'), { code: '[ LLM :: PreCancelled ]' })),
    false
  )
  t.is(isAddonCancelledError(Object.assign(new Error('x'), { code: '[ LLM :: Cancelled ]' })), true)
})

test('isAddonCancelledError: detects the queued-cancel error (message only, no code)', (t) => {
  // A job still queued behind the `parallel` limit when its group is cancelled
  // is rejected by the scheduler as a plain Error with no `.code`.
  const err = new Error(
    'ContinuousBatchScheduler: request cancelled before it could run (queued behind the parallel limit when its group was cancelled)'
  )
  t.is((err as { code?: unknown }).code, undefined)
  t.is(isAddonCancelledError(err), true)
})

test('isAddonCancelledError: ignores unrelated errors', (t) => {
  t.is(isAddonCancelledError(new Error('model failed to load')), false)
  t.is(
    isAddonCancelledError(Object.assign(new Error('x'), { code: '[ LLM :: ContextOverflow ]' })),
    false
  )
  // The message match is anchored to the scheduler's specific phrase, so a
  // generic cancellation message can't false-positive.
  t.is(isAddonCancelledError(new Error('operation was cancelled')), false)
  t.is(isAddonCancelledError(null), false)
  t.is(isAddonCancelledError(undefined), false)
  t.is(isAddonCancelledError('a string'), false)
  t.is(isAddonCancelledError(42), false)
})
