'use strict'

// cliArgs travels from a json: spec through models.cjs validation, into cli-model.env as one
// joined string, and back out as an argv array in cli-fixture-runner.cjs. The flag allowlist
// is checked on the array, so anything that changes the token count between those two points
// escapes it: extra args are appended after the fixed ones in cli-case-runner.js, which is
// enough to override a benchmark-controlled flag such as --ctx-size.

const test = require('node:test')
const assert = require('node:assert/strict')

const { parseModels } = require('../models.cjs')
const { serializeCliArgs, parseCliArgs } = require('../cli-args.cjs')

const BLOBS = {
  llm: { source: { type: 'url', url: 'https://example.com/llm.gguf' }, modelName: 'llm.gguf' },
  mmproj: { source: { type: 'url', url: 'https://example.com/mmproj.gguf' }, modelName: 'mmproj.gguf' }
}

function parseSpec (cliArgs) {
  const spec = Object.assign({ label: 'probe', cliArgs }, BLOBS)
  return parseModels('json:' + JSON.stringify([spec]), null, null)[0]
}

const ACCEPTED = [
  ['split form', ['--image-no-upscale', 'on']],
  // llama.cpp rewrites `_` to `-` before looking an option up, so the allowlist canonicalises
  // it the same way instead of comparing the literal spelling.
  ['underscore form', ['--image_no_upscale', 'on']],
  ['negative number value', ['--image-max-tokens', '-1']],
  ['no args at all', []]
]

for (const [name, args] of ACCEPTED) {
  test(`cliArgs accepts the ${name} and survives the env round trip`, () => {
    const spec = parseSpec(args)
    assert.deepEqual(spec.cliArgs, args)
    assert.deepEqual(parseCliArgs(serializeCliArgs(spec.cliArgs)), args)
  })
}

const REJECTED = [
  ['a space', ['--image-no-upscale on --ctx-size 1']],
  ['a tab', ['--image-no-upscale\t--ctx-size']],
  ['a trailing space', ['--image-no-upscale ']],
  ['a newline', ['--image-no-upscale\n--ctx-size']]
]

for (const [name, args] of REJECTED) {
  test(`cliArgs rejects an element carrying ${name}`, () => {
    assert.throws(() => parseSpec(args), /must not contain whitespace/)
  })
}

// arg.cpp looks the whole argv token up in arg_to_options and never splits on `=`, so the
// equals form reaches llama.cpp as an unknown argument and aborts the run. The workflow logs
// that as a warning, so the only visible symptom is an engine leg with no rows.
const EQUALS_FORM = [
  ['a flag on the allowlist', ['--image-no-upscale=on']],
  ['the underscore spelling', ['--image_no_upscale=on']],
  ['a value element', ['--image-no-upscale', 'on=off']]
]

for (const [name, args] of EQUALS_FORM) {
  test(`cliArgs rejects the equals form on ${name}`, () => {
    assert.throws(() => parseSpec(args), /must use the split form/)
  })
}

test('cliArgs rejects a flag that is not on the allowlist', () => {
  assert.throws(() => parseSpec(['--ctx-size', '1']), /may only carry per-model image preprocessing flags/)
})

test('cliArgs rejects a forbidden flag hidden behind an accepted one', () => {
  assert.throws(() => parseSpec(['--image-no-upscale', 'on', '--ctx-size', '1']),
    /may only carry per-model image preprocessing flags/)
})

test('cliArgs checks a token that only looks like a negative number', () => {
  // isFlagToken exempts negative numbers because `-1` is a legitimate value. The exemption is
  // anchored to a complete number so a token like this is still checked, not waved through.
  assert.throws(() => parseSpec(['-1--ctx-size']), /may only carry per-model image preprocessing flags/)
})

test('cliArgs rejects a flag with no addonConfig twin', () => {
  // The two allowlists move together: a flag the addon cannot be told to match would put the
  // CLI leg on different preprocessing from the addon leg under one model label.
  assert.throws(() => parseSpec(['--image-max-tiles', '8']),
    /may only carry per-model image preprocessing flags/)
})

test('the env round trip preserves token count for every accepted spelling', () => {
  // The property the allowlist depends on: one element in, one argument out. Whitespace is
  // the only way to break it, which is why validation rejects it rather than escaping it.
  for (const [, args] of ACCEPTED) {
    assert.equal(parseCliArgs(serializeCliArgs(args)).length, args.length)
  }
})

test('parseCliArgs drops empty input rather than emitting a blank argument', () => {
  // An empty CLI_EXTRA_ARGS is the normal case for every model that needs no flag, and a
  // stray '' in argv would reach llama.cpp as an unknown empty option.
  assert.deepEqual(parseCliArgs(''), [])
  assert.deepEqual(parseCliArgs(undefined), [])
  assert.deepEqual(parseCliArgs('   '), [])
})
