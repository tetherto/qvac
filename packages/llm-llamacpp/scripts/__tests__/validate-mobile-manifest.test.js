'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  modelNamesInSource,
  prestageIgnores,
  prestageSetDefs,
  prestageUses,
  repinUrls,
  toFunctionName,
  validate
} = require('../validate-mobile-manifest')

const integrationDir = path.resolve(__dirname, '../../test/integration')
const mobileManifest = require('../../test/mobile/model-manifest.json')
const testGroups = require('../../test/mobile/test-groups.json')
const integrationManifest = require('../../test/integration/models.manifest.json')

// Every .js, not just *.test.js — pre-stage sets are defined in the helpers.
function realSources() {
  const sources = {}
  for (const file of fs.readdirSync(integrationDir).filter((f) => f.endsWith('.js'))) {
    sources[file] = fs.readFileSync(path.join(integrationDir, file), 'utf8')
  }
  return sources
}

const PINNED = 'https://huggingface.co/o/r/resolve/0123456789012345678901234567890123456789/m.gguf'
const OTHER_PINNED =
  'https://huggingface.co/o/r/resolve/0123456789012345678901234567890123456789/other.gguf'
const stubManifest = { models: { 'm.gguf': { urls: [PINNED] } } }
const twoModelManifest = {
  models: { 'm.gguf': { urls: [PINNED] }, 'other.gguf': { urls: [OTHER_PINNED] } }
}

// A helper that defines two model tables, the shape of _image-common.js.
function helper(smallModel = 'm.gguf', bigModel = 'other.gguf') {
  return [
    '// prestage-set: small',
    `const SMALL = { llmModel: { modelName: '${smallModel}' } }`,
    '// prestage-set: big',
    `const BIG = { llmModel: { modelName: '${bigModel}' } }`
  ].join('\n')
}

// grammar uses `small`, reasoning uses `big`; both entries match. Neither test
// names a model in its own source — everything comes from the helper.
function helperBacked(overrides = {}) {
  return {
    mobileManifest: {
      runGrammarTest: [{ name: 'm.gguf', url: PINNED }],
      runReasoningTest: [{ name: 'other.gguf', url: OTHER_PINNED }]
    },
    testGroups: { android: { shardA: ['runGrammarTest', 'runReasoningTest'] } },
    integrationManifest: twoModelManifest,
    sources: {
      '_helper.js': helper(),
      'grammar.test.js': "// prestage-uses: small — helper default\nrequire('./_helper.js')",
      'reasoning.test.js': "// prestage-uses: big — passed explicitly\nrequire('./_helper.js')"
    },
    ...overrides
  }
}

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
    errors.some((e) => /runGrammarTest does not stage m\.gguf, which it names directly/.test(e))
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
    integrationManifest: twoModelManifest,
    sources: {
      'grammar.test.js': "const MODEL = { modelName: 'm.gguf' }",
      'reasoning.test.js': "const MODEL = { modelName: 'm.gguf' }"
    }
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^runGrammarTest does not stage m\.gguf/)
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

test('models reached through a labelled helper set count as covered', () => {
  assert.deepEqual(validate(helperBacked()), [])
})

test('changing the helper model without the manifest is reported', () => {
  // gianni-cor's review: the helper swaps its model, the entry is not updated,
  // and Device Farm pre-stages the old file while the phone fetches the new
  // one. The names are read out of the helper, so this cannot stay green.
  const sources = helperBacked().sources
  const errors = validate(
    helperBacked({ sources: { ...sources, '_helper.js': helper('other.gguf') } })
  )
  assert.equal(errors.length, 1)
  assert.match(
    errors[0],
    /^runGrammarTest does not stage other\.gguf, which it reaches through pre-stage set "small"/
  )
})

test('a set the test does not declare is not demanded of it', () => {
  // The over-staging failure mode: reading every model out of a shared helper
  // would push the `big` pair onto every device that runs grammar.
  const errors = validate(helperBacked())
  assert.ok(!errors.some((e) => /other\.gguf/.test(e)))
})

test('an entry anchored to nothing in the code is reported', () => {
  // The blind spot itself: no model names in the test, no set declared, but an
  // entry exists — so no rule could check it.
  const errors = validate({
    mobileManifest: { runGrammarTest: [{ name: 'm.gguf', url: PINNED }] },
    testGroups: { android: { shardA: ['runGrammarTest'] } },
    integrationManifest: stubManifest,
    sources: { 'grammar.test.js': "require('./_helper.js')" }
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /runGrammarTest stages 1 model\(s\) but names none of them/)
})

test('a prestage-uses naming an unknown set is reported', () => {
  const errors = validate({
    mobileManifest: { runGrammarTest: [{ name: 'm.gguf', url: PINNED }] },
    testGroups: { android: { shardA: ['runGrammarTest'] } },
    integrationManifest: stubManifest,
    sources: { 'grammar.test.js': '// prestage-uses: nope — typo\n' }
  })
  assert.ok(errors.some((e) => /names an unknown pre-stage set/.test(e)))
  // ...and the entry is treated as unanchored, not as covered.
  assert.ok(errors.some((e) => /but names none of them/.test(e)))
})

test('a set label that resolves to no models is reported', () => {
  const errors = validate({
    mobileManifest: { runGrammarTest: [{ name: 'm.gguf', url: PINNED }] },
    testGroups: { android: { shardA: ['runGrammarTest'] } },
    integrationManifest: stubManifest,
    sources: {
      '_helper.js': '// prestage-set: small\nconst OTHER = { a: 1 }',
      'grammar.test.js': '// prestage-uses: small — detached label\n'
    }
  })
  assert.ok(errors.some((e) => /pre-stage set "small" resolves to no known models/.test(e)))
})

test('a set defined twice is reported', () => {
  const errors = validate({
    mobileManifest: {},
    testGroups: {},
    integrationManifest: stubManifest,
    sources: {
      '_a.js': "// prestage-set: small\nconst A = { modelName: 'm.gguf' }",
      '_b.js': "// prestage-set: small\nconst B = { modelName: 'm.gguf' }",
      'grammar.test.js': '// prestage-uses: small — x\n'
    }
  })
  assert.ok(errors.some((e) => /pre-stage set "small" is defined twice/.test(e)))
})

test('a set no test declares is reported', () => {
  const errors = validate({
    mobileManifest: {},
    testGroups: {},
    integrationManifest: stubManifest,
    sources: { '_helper.js': "// prestage-set: small\nconst A = { modelName: 'm.gguf' }" }
  })
  assert.ok(errors.some((e) => /"small" is defined but no test declares it/.test(e)))
})

test('a prestage-ignore marker suppresses the coverage error', () => {
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

test('a prestage-uses marker without a reason is rejected', () => {
  const errors = validate(
    helperBacked({
      sources: {
        ...helperBacked().sources,
        'grammar.test.js': '// prestage-uses: small\n'
      }
    })
  )
  assert.ok(errors.some((e) => /prestage-uses for "small" needs a reason/.test(e)))
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

test('prestageUses collects markers with reasons', () => {
  const errors = []
  const uses = prestageUses('// prestage-uses: small — helper default', 'runX', errors)
  assert.deepEqual([...uses], ['small'])
  assert.deepEqual(errors, [])
})

test('prestageSetDefs scopes a label to the literal beneath it', () => {
  const errors = []
  const sets = prestageSetDefs({ '_helper.js': helper() }, errors)
  assert.deepEqual(errors, [])
  assert.deepEqual([...modelNamesInSource(sets.get('small').block)], ['m.gguf'])
  assert.deepEqual([...modelNamesInSource(sets.get('big').block)], ['other.gguf'])
})

test('a set block is not truncated by braces in strings or comments', () => {
  // Brace matching on the raw source ended the block at the first `}` inside a
  // string or comment, silently dropping every model declared after it — an
  // under-report, which is the failure mode this validator exists to prevent.
  const cases = {
    'string with an unmatched brace': "  tmpl: 'closing brace: }',",
    'line comment with a brace': '  // note: } would end the block',
    'block comment with a brace': '  /* } */',
    'balanced template literal': '  url: `${BASE}/x`,'
  }
  for (const [label, noise] of Object.entries(cases)) {
    const src = [
      '// prestage-set: s',
      'const T = {',
      "  a: { modelName: 'm.gguf' },",
      noise,
      "  b: { modelName: 'other.gguf' }",
      '}'
    ].join('\n')
    const sets = prestageSetDefs({ '_h.js': src }, [])
    assert.deepEqual(
      [...modelNamesInSource(sets.get('s').block)].sort(),
      ['m.gguf', 'other.gguf'],
      `${label}: both models stay in the set`
    )
  }
})

test('a brace before the label does not become the block', () => {
  const src = [
    'const EARLIER = { modelName: "other.gguf" }',
    '// prestage-set: s',
    "const T = { a: { modelName: 'm.gguf' } }"
  ].join('\n')
  const sets = prestageSetDefs({ '_h.js': src }, [])
  assert.deepEqual([...modelNamesInSource(sets.get('s').block)], ['m.gguf'])
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
