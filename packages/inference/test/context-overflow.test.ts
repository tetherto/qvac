import test from 'brittle'
import {
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
  // message. The detector must still fire on the message substring so
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

test('isAddonContextOverflowError: message fallback is anchored to known C++ formats', (t) => {
  // Permissive matching on `/context overflow/i` would fire on
  // wrapper / log lines like "recovering from context overflow"
  // — anchor to the two literal C++ emitted strings.
  t.is(isAddonContextOverflowError(new Error('recovering from context overflow upstream')), false)
  t.is(
    isAddonContextOverflowError(new Error('context overflow at prefill step (5 tokens, max 4)')),
    true
  )
  // The batch guards carry the status code (the code branch detects them);
  // the message fallback is kept aligned in case a guard loses its code.
  t.is(
    isAddonContextOverflowError(
      new Error(
        '[TextLlm] context overflow at batch prefill step: prompt tokens 9, max context tokens 4'
      )
    ),
    true
  )
  t.is(isAddonContextOverflowError(new Error('processPromptImpl: context overflow\n')), true)
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
  // MtmdLlmContext.cpp, single-prompt guard: the addon denominates this
  // figure in tokens.
  t.alike(
    parseContextOverflowMessage(
      '[MtmdLlm] context overflow at prefill step (31 tokens, 24 positions, max 8192)\n'
    ),
    { promptTokens: 31, requiredTokens: 31, ctxSize: 8192 }
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

// The failing requirement can never sit below the window; the guards trigger
// on >=, so equality is emittable and the floor is >=, not >.
test('parseContextOverflowMessage: cached overflow requires no less than the window', (t) => {
  const cases = [
    '[TextLlm] context overflow at batch prefill step: cached tokens 8170 plus prompt tokens 31 exceed the max context tokens 8192\n',
    '[MtmdLlm] context overflow at prefill step: cached 5364 positions / 8172 KV cells plus 24 positions / 31 KV cells of prompt exceed the max context tokens 8192\n'
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
