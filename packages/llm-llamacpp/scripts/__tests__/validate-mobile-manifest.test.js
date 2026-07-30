'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  modelNamesInSource,
  prestageIgnores,
  repinUrls,
  toFunctionName,
  validate
} = require('../validate-mobile-manifest')

const integrationDir = path.resolve(__dirname, '../../test/integration')
const mobileManifest = require('../../test/mobile/model-manifest.json')
const testGroups = require('../../test/mobile/test-groups.json')
const integrationManifest = require('../../test/integration/models.manifest.json')

function realSources() {
  const sources = {}
  for (const file of fs.readdirSync(integrationDir).filter((f) => f.endsWith('.test.js'))) {
    sources[file] = fs.readFileSync(path.join(integrationDir, file), 'utf8')
  }
  return sources
}

const PINNED = 'https://huggingface.co/o/r/resolve/0123456789012345678901234567890123456789/m.gguf'
const OTHER_PINNED =
  'https://huggingface.co/o/r/resolve/0123456789012345678901234567890123456789/other.gguf'
const stubManifest = { models: { 'm.gguf': { urls: [PINNED] } } }

test('the committed mobile manifest is a valid pre-stage map', () => {
  const errors = validate({
    mobileManifest,
    testGroups,
    integrationManifest,
    sources: realSources()
  })
  assert.deepEqual(errors, [])
})

test('every test scheduled in test-groups.json is pre-staged', () => {
  // The regression this file exists for: a test lands in a shard but never gets
  // a manifest entry, so its models are fetched on-device instead of pushed.
  for (const groups of Object.values(testGroups)) {
    for (const [group, tests] of Object.entries(groups)) {
      for (const name of tests) {
        assert.ok(mobileManifest[name], `${group}: ${name} has a model-manifest entry`)
      }
    }
  }
})

test('every mobile manifest url is the commit-pinned integration url', () => {
  for (const [name, models] of Object.entries(mobileManifest)) {
    for (const model of models) {
      const entry = integrationManifest.models[model.name]
      assert.ok(entry, `${name}: ${model.name} is in models.manifest.json`)
      assert.equal(model.url, entry.urls[0], `${name}: ${model.name} url is pinned`)
      assert.doesNotMatch(model.url, /\/resolve\/(?:main|master)\//)
    }
  }
})

test('a test missing from the manifest is reported', () => {
  const errors = validate({
    mobileManifest: {},
    testGroups: { android: { shardA: ['runGrammarTest'] } },
    integrationManifest: stubManifest,
    sources: { 'grammar.test.js': '' }
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /runGrammarTest has no model-manifest entry/)
})

test('an unpinned url is reported', () => {
  const errors = validate({
    mobileManifest: {
      runGrammarTest: [{ name: 'm.gguf', url: 'https://huggingface.co/o/r/resolve/main/m.gguf' }]
    },
    testGroups: {},
    integrationManifest: stubManifest,
    sources: { 'grammar.test.js': '' }
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /url is not the pinned models.manifest.json url/)
})

test('a model the test names but its own entry omits is reported', () => {
  const errors = validate({
    mobileManifest: { runGrammarTest: [] },
    testGroups: { android: { shardA: ['runGrammarTest'] } },
    integrationManifest: stubManifest,
    sources: { 'grammar.test.js': "const MODEL = { modelName: 'm.gguf' }" }
  })
  assert.ok(
    errors.some((e) => /references m\.gguf but its own manifest entry does not stage it/.test(e))
  )
})

test('a sibling test in the same shard does NOT satisfy coverage', () => {
  // The regression this rule exists for: grammar references m.gguf, but only
  // reasoning declares it. A shard-wide union would pass this and the gap would
  // reappear the moment either test is moved to another shard — which is how
  // three of the real gaps stayed invisible on main.
  const errors = validate({
    mobileManifest: {
      runGrammarTest: [{ name: 'other.gguf', url: OTHER_PINNED }],
      runReasoningTest: [{ name: 'm.gguf', url: PINNED }]
    },
    testGroups: { android: { shardA: ['runGrammarTest', 'runReasoningTest'] } },
    integrationManifest: {
      models: { 'm.gguf': { urls: [PINNED] }, 'other.gguf': { urls: [OTHER_PINNED] } }
    },
    sources: {
      'grammar.test.js': "const MODEL = { modelName: 'm.gguf' }",
      'reasoning.test.js': "const MODEL = { modelName: 'm.gguf' }"
    }
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^runGrammarTest references m\.gguf but its own manifest entry/)
})

test('splitting a shard cannot regress coverage that already passed', () => {
  // Same manifest, two shard layouts: a valid manifest must stay valid when the
  // scheduler moves tests around.
  const mobileManifest = {
    runGrammarTest: [{ name: 'm.gguf', url: PINNED }],
    runReasoningTest: [{ name: 'm.gguf', url: PINNED }]
  }
  const sources = {
    'grammar.test.js': "const MODEL = { modelName: 'm.gguf' }",
    'reasoning.test.js': "const MODEL = { modelName: 'm.gguf' }"
  }
  const together = validate({
    mobileManifest,
    testGroups: { android: { shardA: ['runGrammarTest', 'runReasoningTest'] } },
    integrationManifest: stubManifest,
    sources
  })
  const split = validate({
    mobileManifest,
    testGroups: { android: { shardA: ['runGrammarTest'], shardB: ['runReasoningTest'] } },
    integrationManifest: stubManifest,
    sources
  })
  assert.deepEqual(together, [])
  assert.deepEqual(split, [])
})

test('a prestage-ignore marker suppresses the shard-coverage error', () => {
  const src = "// prestage-ignore: m.gguf — desktop only\nconst M = { modelName: 'm.gguf' }"
  const errors = validate({
    mobileManifest: { runGrammarTest: [{ name: 'm.gguf', url: PINNED }] },
    testGroups: { android: { shardA: ['runGrammarTest'] } },
    integrationManifest: stubManifest,
    sources: { 'grammar.test.js': src }
  })
  assert.deepEqual(errors, [])
})

test('a prestage-ignore marker without a reason is rejected', () => {
  const errors = validate({
    mobileManifest: { runGrammarTest: [{ name: 'm.gguf', url: PINNED }] },
    testGroups: { android: { shardA: ['runGrammarTest'] } },
    integrationManifest: stubManifest,
    sources: { 'grammar.test.js': '// prestage-ignore: m.gguf' }
  })
  assert.ok(errors.some((e) => /needs a reason/.test(e)))
})

test('a stale manifest key with no test file is reported', () => {
  const errors = validate({
    mobileManifest: { runGoneTest: [{ name: 'm.gguf', url: PINNED }] },
    testGroups: {},
    integrationManifest: stubManifest,
    sources: {}
  })
  assert.ok(errors.some((e) => /no matching test\/integration/.test(e)))
})

test('modelNamesInSource picks up names, not urls', () => {
  const names = modelNamesInSource(
    "const HF = 'https://x/y/resolve/abc/model-a.gguf'\nconst n = 'model-a.gguf'\n" +
      'const t = `${HF}/model-b.gguf`'
  )
  assert.deepEqual([...names], ['model-a.gguf'])
})

test('prestageIgnores collects markers with reasons', () => {
  const errors = []
  const ignored = prestageIgnores('// prestage-ignore: big.gguf — 27 GB', 'runX', errors)
  assert.deepEqual([...ignored], ['big.gguf'])
  assert.deepEqual(errors, [])
})

test('repinUrls rewrites to the integration manifest url', () => {
  const manifest = { runGrammarTest: [{ name: 'm.gguf', url: 'https://stale/m.gguf' }] }
  assert.equal(repinUrls(manifest, stubManifest), 1)
  assert.equal(manifest.runGrammarTest[0].url, PINNED)
  assert.equal(repinUrls(manifest, stubManifest), 0)
})

test('toFunctionName mirrors the mobile test generator', () => {
  assert.equal(toFunctionName('gemma4.test.js'), 'runGemma4Test')
  assert.equal(
    toFunctionName('qwen3-5-image-tile-mode-tokens.test.js'),
    'runQwen35ImageTileModeTokensTest'
  )
})
