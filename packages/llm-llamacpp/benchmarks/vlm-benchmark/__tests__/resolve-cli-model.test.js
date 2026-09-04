'use strict'

// resolve-cli-model.cjs is the only thing standing between a json: spec and the URL the
// workflow hands to curl with the HF token attached, so its URL construction is worth
// pinning: a nested HF path must survive, a traversal must not, and a registry source must
// come out with no URL at all so the workflow knows to look for an addon leg instead.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { execFileSync } = require('child_process')

const DIR = path.resolve(__dirname, '..')
const SCRIPT = path.join(DIR, 'resolve-cli-model.cjs')

function resolve (spec) {
  const out = execFileSync(process.execPath, [SCRIPT], {
    cwd: DIR,
    encoding: 'utf8',
    env: { ...process.env, QVAC_VLM_MODELS: 'json:' + JSON.stringify([spec]) }
  })
  const env = {}
  for (const line of out.split('\n')) {
    const m = line.match(/^(\w+)='(.*)'$/)
    if (m) env[m[1]] = m[2].replace(/'\\''/g, "'")
  }
  return env
}

const hf = (file) => ({ type: 'hf', repo: 'owner/repo', sha: 'a'.repeat(40), file })

function specWith (llmSource, mmprojSource) {
  return {
    label: 'probe',
    llm: { source: llmSource, modelName: 'llm.gguf' },
    mmproj: { source: mmprojSource || hf('mmproj.gguf'), modelName: 'mmproj.gguf' }
  }
}

test('a nested hf file path resolves instead of being rejected', () => {
  // HF repos nest, and the pair form accepts these, so rejecting them here would refuse a
  // spec the rest of the pipeline considers valid.
  const env = resolve(specWith(hf('tinyllamas/stories260K.gguf')))
  assert.equal(env.LLM_URL, `https://huggingface.co/owner/repo/resolve/${'a'.repeat(40)}/tinyllamas/stories260K.gguf`)
})

test('a plain hf file path still resolves', () => {
  const env = resolve(specWith(hf('model-Q8_0.gguf')))
  assert.match(env.LLM_URL, /\/resolve\/a{40}\/model-Q8_0\.gguf$/)
})

for (const [name, file] of [
  ['parent traversal', '../../etc/passwd'],
  ['a dot segment', 'weights/./model.gguf'],
  ['a parent segment mid-path', 'weights/../../model.gguf'],
  ['an empty segment', 'weights//model.gguf'],
  ['a trailing slash', 'weights/']
]) {
  test(`an hf file path with ${name} is rejected`, () => {
    assert.throws(() => resolve(specWith(hf(file))))
  })
}

test('a registry source resolves to an empty URL', () => {
  // The workflow keys off this: no URL means the blob must already be on disk from an addon
  // leg, and a CLI-only dispatch has to fail with that explanation rather than curl ''.
  const env = resolve(specWith({ type: 'registry', source: 'core', path: 'visionpsy/q4' }))
  assert.equal(env.LLM_URL, '')
  assert.equal(env.LLM_NAME, 'llm.gguf')
})

test('a manifest-pinned modelName emits its sha256', () => {
  // The CLI legs verify against this, so an entry the manifest pins must carry the pin
  // through even when the spec itself gives no sha256.
  const spec = {
    label: 'probe',
    llm: { source: hf('x.gguf'), modelName: 'Qwen3.5-0.8B-Q8_0.gguf' },
    mmproj: { source: hf('y.gguf'), modelName: 'mmproj-Qwen3.5-0.8B-F16.gguf' }
  }
  const env = resolve(spec)
  assert.match(env.LLM_SHA256, /^[0-9a-f]{64}$/)
  assert.match(env.MMPROJ_SHA256, /^[0-9a-f]{64}$/)
})

test('an unpinned blob emits an empty sha256 rather than inventing one', () => {
  const env = resolve(specWith(hf('x.gguf')))
  assert.equal(env.LLM_SHA256, '')
})
