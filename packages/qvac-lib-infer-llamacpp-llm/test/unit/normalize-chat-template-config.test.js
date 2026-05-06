'use strict'

const test = require('brittle')
const { normalizeChatTemplateConfig } = require('../../index.js')

// Both keys are absent — config returned as-is (referentially identical).
test('passthrough when neither key present', function (t) {
  const cfg = { device: 'gpu', gpu_layers: '999' }
  t.is(normalizeChatTemplateConfig(cfg), cfg)
})

test('passthrough when value is undefined', function (t) {
  const cfg = { device: 'gpu', use_model_chat_template: undefined }
  t.is(normalizeChatTemplateConfig(cfg), cfg)
})

test('passthrough when value is null', function (t) {
  const cfg = { device: 'gpu', use_model_chat_template: null }
  t.is(normalizeChatTemplateConfig(cfg), cfg)
})

// Native booleans coerce to canonical "true"/"false" strings.
test('boolean true -> "true" string', function (t) {
  const out = normalizeChatTemplateConfig({ use_model_chat_template: true })
  t.is(out.use_model_chat_template, 'true')
})

test('boolean false -> "false" string', function (t) {
  const out = normalizeChatTemplateConfig({ use_model_chat_template: false })
  t.is(out.use_model_chat_template, 'false')
})

// String values: case-insensitive, "1"/"0" aliases accepted.
test('string "true" passthrough', function (t) {
  const out = normalizeChatTemplateConfig({ use_model_chat_template: 'true' })
  t.is(out.use_model_chat_template, 'true')
})

test('string "TRUE" -> "true"', function (t) {
  const out = normalizeChatTemplateConfig({ use_model_chat_template: 'TRUE' })
  t.is(out.use_model_chat_template, 'true')
})

test('string "False" -> "false"', function (t) {
  const out = normalizeChatTemplateConfig({ use_model_chat_template: 'False' })
  t.is(out.use_model_chat_template, 'false')
})

test('string "1" -> "true"', function (t) {
  const out = normalizeChatTemplateConfig({ use_model_chat_template: '1' })
  t.is(out.use_model_chat_template, 'true')
})

test('string "0" -> "false"', function (t) {
  const out = normalizeChatTemplateConfig({ use_model_chat_template: '0' })
  t.is(out.use_model_chat_template, 'false')
})

test('whitespace-only string -> "false"', function (t) {
  const out = normalizeChatTemplateConfig({ use_model_chat_template: '  ' })
  t.is(out.use_model_chat_template, 'false')
})

// Kebab-case alias is accepted and folded into the snake_case canonical form.
test('kebab-case alias is accepted and folded', function (t) {
  const out = normalizeChatTemplateConfig({ 'use-model-chat-template': true })
  t.is(out.use_model_chat_template, 'true')
  t.is(out['use-model-chat-template'], undefined, 'alias removed from output')
})

test('both keys with same value (different forms) merge cleanly', function (t) {
  const out = normalizeChatTemplateConfig({
    use_model_chat_template: 'TRUE',
    'use-model-chat-template': true
  })
  t.is(out.use_model_chat_template, 'true')
  t.is(out['use-model-chat-template'], undefined)
})

// Conflicts and bad values throw a TypeError with a clear message.
// Note: brittle's plain `t.exception` deliberately re-raises native error
// subclasses (TypeError / RangeError / etc.) — use `t.exception.all` to catch
// them like any other throw. Also see grammar.test.js for the same pattern.
test('conflicting values throw TypeError', async function (t) {
  await t.exception.all(() => normalizeChatTemplateConfig({
    use_model_chat_template: true,
    'use-model-chat-template': false
  }), /Conflicting values/)
})

test('non-true/false string throws TypeError', async function (t) {
  await t.exception.all(() => normalizeChatTemplateConfig({
    use_model_chat_template: 'yes'
  }), /must be a boolean or one of/)
})

test('numeric value throws TypeError', async function (t) {
  await t.exception.all(() => normalizeChatTemplateConfig({
    use_model_chat_template: 1
  }), /must be a boolean or string/)
})

test('object value throws TypeError', async function (t) {
  await t.exception.all(() => normalizeChatTemplateConfig({
    use_model_chat_template: { foo: 'bar' }
  }), /must be a boolean or string/)
})

// Hardening: input is not mutated; unrelated keys are preserved.
test('does not mutate input config', function (t) {
  const input = { device: 'gpu', use_model_chat_template: true }
  const snapshot = { ...input }
  normalizeChatTemplateConfig(input)
  t.alike(input, snapshot, 'input config must remain unchanged')
})

test('preserves unrelated keys in output', function (t) {
  const out = normalizeChatTemplateConfig({
    device: 'gpu',
    gpu_layers: '999',
    use_model_chat_template: true
  })
  t.is(out.device, 'gpu')
  t.is(out.gpu_layers, '999')
  t.is(out.use_model_chat_template, 'true')
})

// Defensive: non-object inputs flow through unchanged (matches the helper's
// "best-effort, never throw on shape" contract for callers).
test('non-object input passes through', function (t) {
  t.is(normalizeChatTemplateConfig(null), null)
  t.is(normalizeChatTemplateConfig(undefined), undefined)
  t.is(normalizeChatTemplateConfig('not-a-config'), 'not-a-config')
})
