'use strict'

// cliArgs travels from a json: spec through models.cjs validation, into cli-model.env as one
// joined string, and back out as an argv array in cli-fixture-runner.cjs. The flag allowlist
// is checked on the array, so anything that changes the token count between those two points
// escapes it: extra args are appended after the fixed ones in cli-case-runner.js, which is
// enough to override a benchmark-controlled flag such as --ctx-size.

const test = require('node:test')
const assert = require('node:assert/strict')

const { parseModels, assertTwinsMatch } = require('../models.cjs')
const { serializeCliArgs, parseCliArgs } = require('../cli-args.cjs')

const BLOBS = {
  llm: { source: { type: 'url', url: 'https://example.com/llm.gguf' }, modelName: 'llm.gguf' },
  mmproj: { source: { type: 'url', url: 'https://example.com/mmproj.gguf' }, modelName: 'mmproj.gguf' }
}

function parseSpec (cliArgs, addonConfig) {
  const spec = Object.assign({ label: 'probe', cliArgs }, BLOBS)
  if (addonConfig !== undefined) spec.addonConfig = addonConfig
  return parseModels('json:' + JSON.stringify([spec]), null, null)[0]
}

// Every accepted case carries the addonConfig twin, because a flag set on one leg only is
// rejected now. The twin rule has its own cases further down.
const ACCEPTED = [
  ['split form', ['--image-no-upscale', 'on'], { 'image-no-upscale': 'on' }],
  // llama.cpp rewrites `_` to `-` before looking an option up, so the allowlist canonicalises
  // it the same way instead of comparing the literal spelling. Same for the addon key.
  ['underscore form', ['--image_no_upscale', 'on'], { image_no_upscale: 'on' }],
  ['negative number value', ['--image-max-tokens', '-1'], { 'image-max-tokens': '-1' }],
  ['no args at all', [], undefined]
]

for (const [name, args, addonConfig] of ACCEPTED) {
  test(`cliArgs accepts the ${name} and survives the env round trip`, () => {
    const spec = parseSpec(args, addonConfig)
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
  // Both allowlists come off one descriptor: a flag the addon cannot be told to match is on
  // neither, so it cannot put the two legs on different preprocessing under one label.
  assert.throws(() => parseSpec(['--image-max-tiles', '8'], { 'image-max-tiles': '8' }),
    /may only carry per-model image preprocessing flags/)
})

// The pairing is what keeps a several-sources comparison honest, so it is enforced per spec
// and not just documented. Without it a Flash leg on upstream-cli silently runs base
// preprocessing under the same model label as the addon leg.
test('a cliArgs flag with no addonConfig entry is rejected', () => {
  assert.throws(() => parseSpec(['--image-no-upscale', 'on'], {}),
    /must set the same preprocessing on both legs/)
})

test('a cliArgs flag with no addonConfig at all is rejected', () => {
  assert.throws(() => parseSpec(['--image-no-upscale', 'on']),
    /addonConfig has no 'image-no-upscale'/)
})

test('an addonConfig key with no cliArgs flag is rejected', () => {
  assert.throws(() => parseSpec([], { 'image-no-upscale': 'on' }),
    /cliArgs has no --image-no-upscale/)
})

test('the two legs disagreeing on a value is rejected', () => {
  assert.throws(() => parseSpec(['--image-tile-mode', 'batched'], { 'image-tile-mode': 'sequential' }),
    /is 'batched' but addonConfig 'image-tile-mode' is 'sequential'/)
})

test('mmproj-use-gpu needs no cliArgs twin', () => {
  // Addon-only by design: it picks the projector backend, which the CLI legs have no flag for.
  const spec = parseSpec([], { 'mmproj-use-gpu': 'on' })
  assert.deepEqual(spec.addonConfig, { 'mmproj-use-gpu': 'on' })
})

test('every committed catalog entry satisfies the twin rule', () => {
  // normalizeSpec only runs on json: specs, so the catalog would otherwise never be checked,
  // and it is exactly where a silent one-leg flag would ship.
  const { catalog } = require('../config.cjs')
  for (const [name, spec] of Object.entries(catalog)) {
    assert.doesNotThrow(() => assertTwinsMatch(spec, name), `catalog entry ${name}`)
  }
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
