import test from 'brittle'
import {
  isAddonPreMutationRefusal,
  isAddonContextOverflowError,
  parseContextOverflowMessage
} from '@/plugins/builtin/llamacpp-completion/ops/context-overflow'

// The addon's structured-code format from
// `qvac_errors::StatusError::codeString()`:
// `"[ <addonId> :: <localCodeMsg> ]"`. Bare's `js_throw_error(env,
// code, msg)` sets this string on the JS Error's `.code`.
const ADDON_CODE = '[ TextLlmAddon :: ContextOverflow ]'

test("isAddonContextOverflowError: detects addon's structured codeString", (t) => {
  const err = Object.assign(new Error('anything'), { code: ADDON_CODE })
  t.is(isAddonContextOverflowError(err), true)
})

test('isAddonContextOverflowError: detects message-only fallback path', (t) => {
  // `LlamaModel::processPromptImpl` emits `"<func>: context overflow\n"`
  // with neither a structured code on the Error nor numbers in the
  // message. The detector must still fire on the message alone so
  // the consumer gets a typed error instead of a generic
  // `CompletionFailedError`.
  const bareForm = new Error('processPromptImpl: context overflow\n')
  t.is(isAddonContextOverflowError(bareForm), true)
})

test('isAddonContextOverflowError: ignores unrelated errors', (t) => {
  t.is(isAddonContextOverflowError(new Error('model failed to load')), false)
  t.is(
    isAddonContextOverflowError(
      Object.assign(new Error('x'), { code: '[ TtsAddon :: InternalError ]' })
    ),
    false
  )
  t.is(isAddonContextOverflowError(null), false)
  t.is(isAddonContextOverflowError(undefined), false)
  t.is(isAddonContextOverflowError('a string'), false)
  t.is(isAddonContextOverflowError(42), false)
})

test("isAddonContextOverflowError: codeString anchored — sibling names don't match", (t) => {
  // The detector should fire ONLY when the codeString ends in
  // `:: ContextOverflow ]` — a future addon-side rename like
  // `ContextOverflowRecovered` or `PostContextOverflow` must not
  // silently route here.
  t.is(
    isAddonContextOverflowError(
      Object.assign(new Error('x'), { code: '[ TextLlmAddon :: ContextOverflowRecovered ]' })
    ),
    false
  )
  t.is(
    isAddonContextOverflowError(
      Object.assign(new Error('x'), { code: '[ TextLlmAddon :: PostContextOverflow ]' })
    ),
    false
  )
  // The exact form still matches.
  t.is(
    isAddonContextOverflowError(
      Object.assign(new Error('x'), { code: '[ TextLlmAddon :: ContextOverflow ]' })
    ),
    true
  )
})

test('isAddonContextOverflowError: message fallback is anchored to the emitted starts', (t) => {
  // Every real emitter, current and retired, starts with its context tag —
  // this detector selects cache preservation, so wrapper text must not match.
  const accepted = [
    '[MtmdLlm] context overflow at prefill step (5 tokens, max 4)',
    '[MtmdLlm] context overflow at prefill step: cached 3 positions / 6 KV cells plus 2 positions / 3 KV cells of prompt exceed the max context tokens 8',
    '[TextLlm] context overflow at batch prefill step: prompt tokens 9, max context tokens 4',
    'processPromptImpl: context overflow\n'
  ]
  for (const wording of accepted) {
    t.is(isAddonContextOverflowError(new Error(wording)), true, `accepted: ${wording.slice(0, 60)}`)
  }
  const rejected = [
    'recovering from context overflow upstream',
    'context overflow at prefill step (5 tokens, max 4)',
    'post-write failure while handling context overflow at prefill step from a prior cause',
    '[TextLlm] context overflow at batch prefill step: prompt tokens 9, max context tokens 4\npost-write failure'
  ]
  for (const wording of rejected) {
    t.is(
      isAddonContextOverflowError(new Error(wording)),
      false,
      `rejected: ${wording.slice(0, 60)}`
    )
  }
})

// Production errors arrive through the async transport as exception.what()
// alone — no code — so message-only recognition must be exact.
test('isAddonPreMutationRefusal: recognises the enumerated refusal forms', (t) => {
  const wordings = [
    'ContinuousBatchScheduler::submit: prompt of 600 KV cells exceeds per-sequence cap 512 (ctxTotalTokens / n_parallel)',
    'ContinuousBatchScheduler::submit: prompt of 512 tokens leaves no room under per-sequence cap 512 (ctxTotalTokens / n_parallel)',
    'ContinuousBatchScheduler::submit: prefill prompt of 600 tokens exceeds per-sequence cap 512 (ctxTotalTokens / n_parallel)',
    'ContinuousBatchScheduler::submit: n_predict 480 + prompt 300 KV cells exceeds per-sequence cap 512 (ctxTotalTokens / n_parallel)',
    'ContinuousBatchScheduler::submit: failed to add to batch (MultiRequestBatcher::AddStatus=2)',
    "invalid generationParams.json_schema: [json.exception.parse_error.101] parse error at line 1, column 2: syntax error while parsing value - invalid literal; last read: 'no'",
    'failed to initialise sampler with per-request generationParams (invalid grammar or json_schema?)'
  ]
  for (const wording of wordings) {
    t.is(isAddonPreMutationRefusal(new Error(wording)), true, `plain (async shape): ${wording}`)
  }
  // A code only exists on the synchronous path: correct one accepted,
  // any other rejected even with a valid wording.
  t.is(
    isAddonPreMutationRefusal(
      Object.assign(new Error(wordings[0]!), { code: '[ LLM :: InvalidArgument ]' })
    ),
    true
  )
  t.is(
    isAddonPreMutationRefusal(
      Object.assign(new Error(wordings[0]!), { code: '[ LLM :: ContextOverflow ]' })
    ),
    false,
    'a different status code disqualifies the wording'
  )
  // Strictness probes: the message is the safety boundary, so near-misses
  // and impossible or out-of-range variants must all be rejected.
  const rejected = [
    'some other InvalidArgument from the scheduler',
    `wrapped: ${wordings[0]!}`,
    `${wordings[0]!}\npost-persistence save failed`,
    'ContinuousBatchScheduler::submit: failed to add to batch (MultiRequestBatcher::AddStatus=0)',
    'ContinuousBatchScheduler::submit: failed to add to batch (MultiRequestBatcher::AddStatus=-1)',
    'ContinuousBatchScheduler::submit: n_predict 0 + prompt 300 KV cells exceeds per-sequence cap 512 (ctxTotalTokens / n_parallel)',
    'ContinuousBatchScheduler::submit: failed to add to batch (MultiRequestBatcher::AddStatus=9)',
    'ContinuousBatchScheduler::submit: n_predict -1 + prompt 300 KV cells exceeds per-sequence cap 512 (ctxTotalTokens / n_parallel)',
    'ContinuousBatchScheduler::submit: prefill prompt of 5 KV cells leaves no room under per-sequence cap 512 (ctxTotalTokens / n_parallel)',
    '[TextLlm] context overflow at batch prefill step: prompt tokens 9, max context tokens 4'
  ]
  for (const wording of rejected) {
    t.is(isAddonPreMutationRefusal(new Error(wording)), false, `rejected: ${wording.slice(0, 60)}`)
  }
})

test('parseContextOverflowMessage: extracts from long-form TextLlm message', (t) => {
  // The long form comes from
  // `TextLlmContext.cpp` when it formats both numbers explicitly:
  // `"[TextLlm] context overflow at prefill step: prompt tokens N,
  //   max context tokens M\n"`.
  const msg =
    '[TextLlm] context overflow at prefill step: prompt tokens 5432, max context tokens 4096\n'
  t.alike(parseContextOverflowMessage(msg), {
    promptTokens: 5432,
    requiredTokens: 5432,
    ctxSize: 4096
  })
})

test('parseContextOverflowMessage: extracts from short-form bracketed message', (t) => {
  // The retired short form reports a cached total, so promptTokens stays unset.
  const text = '[TextLlm] context overflow at prefill step (8192 tokens, max 4096)\n'
  t.alike(parseContextOverflowMessage(text), {
    requiredTokens: 8192,
    ctxSize: 4096
  })

  const mtmd = '[MtmdLlm] context overflow at prefill step (1024 tokens, max 512)\n'
  t.alike(parseContextOverflowMessage(mtmd), {
    requiredTokens: 1024,
    ctxSize: 512
  })
})

// One case per guard, using the strings the addon actually emits.
// promptTokens carries only token-denominated figures.
test('parseContextOverflowMessage: covers every current addon guard', (t) => {
  // TextLlmContext.cpp, first batch-prefill guard.
  t.alike(
    parseContextOverflowMessage(
      '[TextLlm] context overflow at batch prefill step: prompt tokens 4013, max context tokens 512\n'
    ),
    { promptTokens: 4013, requiredTokens: 4013, ctxSize: 512 }
  )
  // TextLlmContext.cpp, cached-plus-prompt guard: the appended prompt stays
  // in promptTokens, the sum that failed the guard is requiredTokens.
  t.alike(
    parseContextOverflowMessage(
      '[TextLlm] context overflow at batch prefill step: cached tokens 8170 plus prompt tokens 31 exceed the max context tokens 8192\n'
    ),
    { promptTokens: 31, cachedTokens: 8170, requiredTokens: 8201, ctxSize: 8192 }
  )
  // MtmdLlmContext.cpp single-prompt guard: its "tokens" figure is KV
  // cells, so promptTokens stays unset.
  t.alike(
    parseContextOverflowMessage(
      '[MtmdLlm] context overflow at prefill step (31 tokens, 24 positions, max 8192)\n'
    ),
    { requiredTokens: 31, ctxSize: 8192 }
  )
  // MtmdLlmContext.cpp, cached-plus-prompt guard: the prompt figure is KV
  // cells, so promptTokens stays unset.
  t.alike(
    parseContextOverflowMessage(
      '[MtmdLlm] context overflow at prefill step: cached 5364 positions / 8172 KV cells plus 24 positions / 31 KV cells of prompt exceed the max context tokens 8192\n'
    ),
    { cachedTokens: 8172, requiredTokens: 8203, ctxSize: 8192 }
  )
  // MtmdLlmContext.cpp, batch guard: KV cells again, promptTokens unset.
  t.alike(
    parseContextOverflowMessage(
      '[MtmdLlm] context overflow at batch prefill step: prompt spans 24 positions / 31 KV cells, max context tokens 8192\n'
    ),
    { requiredTokens: 31, ctxSize: 8192 }
  )
})

// Positions-dominant messages are synthetic malformed-input probes (valid
// addon state keeps cells >= positions); the defensive max must still hold.
test('parseContextOverflowMessage: positions-dominant probes keep the invariant defensively', (t) => {
  t.alike(
    parseContextOverflowMessage(
      '[MtmdLlm] context overflow at prefill step: cached 8100 positions / 1000 KV cells plus 200 positions / 50 KV cells of prompt exceed the max context tokens 8192\n'
    ),
    { cachedTokens: 8100, requiredTokens: 8300, ctxSize: 8192 }
  )
  t.alike(
    parseContextOverflowMessage(
      '[MtmdLlm] context overflow at batch prefill step: prompt spans 8300 positions / 300 KV cells, max context tokens 8192\n'
    ),
    { requiredTokens: 8300, ctxSize: 8192 }
  )
  t.alike(
    parseContextOverflowMessage(
      '[MtmdLlm] context overflow at prefill step (300 tokens, 8300 positions, max 8192)\n'
    ),
    { requiredTokens: 8300, ctxSize: 8192 }
  )
})

// The failing requirement can never sit below the window; the guards trigger
// on >=, so equality is emittable and the floor is >=, not >.
test('parseContextOverflowMessage: cached overflow requires no less than the window', (t) => {
  const cases = [
    '[TextLlm] context overflow at batch prefill step: cached tokens 8170 plus prompt tokens 31 exceed the max context tokens 8192\n',
    '[MtmdLlm] context overflow at prefill step: cached 5364 positions / 8172 KV cells plus 24 positions / 31 KV cells of prompt exceed the max context tokens 8192\n',
    '[MtmdLlm] context overflow at prefill step: cached 8100 positions / 1000 KV cells plus 200 positions / 50 KV cells of prompt exceed the max context tokens 8192\n'
  ]
  for (const message of cases) {
    const { requiredTokens, ctxSize } = parseContextOverflowMessage(message)
    t.ok(requiredTokens !== undefined && ctxSize !== undefined, `both fields parsed: ${message}`)
    t.ok(
      requiredTokens !== undefined && ctxSize !== undefined && requiredTokens >= ctxSize,
      `${requiredTokens} must be at least ${ctxSize}`
    )
  }
})

test('parseContextOverflowMessage: empty result when numbers are absent', (t) => {
  // `LlamaModel::processPromptImpl` emits a bare message with no
  // numbers — both fields stay undefined so `ContextOverflowError`
  // can fall through to the message-only constructor path.
  t.alike(parseContextOverflowMessage('processPromptImpl: context overflow\n'), {})
  t.alike(parseContextOverflowMessage(''), {})
})
