import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  COREML_FAMILIES,
  SHARD_FILENAME,
  buildModelCachePlan,
  cacheLayoutFor,
  coremlSetFor,
  mergeModelCacheEntries,
  shortHash
} from '../../dist/runners/js/shared/model-cache-plan.js'
// The cache action validates every plan entry and recomputes its key; both sides must agree.
import { validatePlan } from '../../../../.github/actions/sdk-e2e-model-cache/src/entries.mjs'
import {
  resolveBootstrapDeps,
  resolveBootstrapModels
} from '../../dist/runners/js/shared/bootstrap-deps.js'

const sha = (text) => createHash('sha256').update(text).digest('hex')

const single = {
  name: 'LLAMA',
  registryPath: 'qvac_models_compiled/ggml/llama/2026-01-01/llama-q4_0.gguf',
  registrySource: 's3',
  expectedSize: 100,
  sha256Checksum: sha('llama')
}

const PARAKEET_ROOT = 'qvac_models_compiled/ggml/parakeet/2026-09-28/'
const COMPONENTS = [
  'analytics/coremldata.bin',
  'coremldata.bin',
  'metadata.json',
  'model.mil',
  'weights/weight.bin'
]
const parakeet = {
  name: 'PARAKEET',
  registryPath: 'qvac_models_compiled/ggml/parakeet/2026-01-01/parakeet-tdt-0.6b-v3.q4_0.gguf',
  registrySource: 's3',
  expectedSize: 50,
  sha256Checksum: sha('parakeet')
}
const encoder = COMPONENTS.map((component, index) => ({
  name: `ENC_${index}`,
  registryPath: `${PARAKEET_ROOT}parakeet-tdt-0.6b-v3-encoder.mlmodelc/${component}`,
  registrySource: 's3',
  expectedSize: index + 1,
  sha256Checksum: sha(component)
}))
const byPathOf = (items) =>
  new Map(items.map((item) => [`${item.registrySource}:${item.registryPath}`, item]))

test('shortHash is the SDK generateShortHash: first 16 hex of sha256', () => {
  assert.equal(shortHash('abc'), sha('abc').slice(0, 16))
})

test('a single-file model is one flat file keyed by its registry checksum', () => {
  const layout = cacheLayoutFor(single, 'linux')
  const file = `${shortHash(single.registryPath)}_llama-q4_0.gguf`
  assert.deepEqual(layout.paths, [file])
  assert.deepEqual(layout.files, [{ path: file, size: 100, sha256: single.sha256Checksum }])
  assert.equal(layout.contentId, single.sha256Checksum)
})

test('a sharded model stays uncached: its tensors file is not registry-pinned', () => {
  const sharded = {
    ...single,
    registryPath: 'qvac_models_compiled/ggml/big/2026-01-01/m-00001-of-00002.gguf',
    shardMetadata: [
      { filename: 'm-00001-of-00002.gguf', expectedSize: 10, sha256Checksum: sha('a') },
      { filename: 'm-00002-of-00002.gguf', expectedSize: 20, sha256Checksum: sha('b') }
    ]
  }
  assert.equal(cacheLayoutFor(sharded, 'linux'), undefined)
  assert.equal(cacheLayoutFor({ ...sharded, shardMetadata: undefined }, 'linux'), undefined)
})

test('a companion set is its set directory and its key ignores file order', () => {
  const files = [
    { targetName: 'b.bin', expectedSize: 2, sha256Checksum: sha('b') },
    { targetName: 'a.bin', expectedSize: 1, sha256Checksum: sha('a') }
  ]
  const one = cacheLayoutFor({ ...single, companionSet: { setKey: 'set1', files } }, 'macos')
  const two = cacheLayoutFor(
    { ...single, companionSet: { setKey: 'set1', files: [...files].reverse() } },
    'macos'
  )
  assert.deepEqual(one.paths, ['sets/set1'])
  assert.equal(one.contentId, two.contentId)
  assert.equal(one.expectedSize, 3)
  assert.deepEqual(one.files.map((file) => file.path).sort(), [
    'sets/set1/a.bin',
    'sets/set1/b.bin'
  ])
})

test('a Core ML model on macOS is the catalog set: GGUF plus every complete bundle', () => {
  const byPath = byPathOf([parakeet, ...encoder])
  const key = shortHash(`s3:${parakeet.registryPath}:coreml:${PARAKEET_ROOT}`)
  const layout = cacheLayoutFor(parakeet, 'macos', byPath)
  assert.deepEqual(layout.paths, [`sets/${key}`])
  assert.deepEqual(
    layout.files.map((file) => [file.path, file.size, file.sha256]),
    [
      [`sets/${key}/parakeet-tdt-0.6b-v3.q4_0.gguf`, 50, parakeet.sha256Checksum],
      ...COMPONENTS.map((component, index) => [
        `sets/${key}/parakeet-tdt-0.6b-v3-encoder.mlmodelc/${component}`,
        index + 1,
        sha(component)
      ])
    ]
  )
})

test('a Core ML model is flat off macOS, uncached on macOS without a complete catalog bundle', () => {
  const flat = [`${shortHash(parakeet.registryPath)}_parakeet-tdt-0.6b-v3.q4_0.gguf`]
  const complete = byPathOf([parakeet, ...encoder])
  assert.deepEqual(cacheLayoutFor(parakeet, 'linux', complete).paths, flat)
  // The SDK then asks the live registry for the bundles, so the layout is unknown.
  assert.equal(cacheLayoutFor(parakeet, 'macos', byPathOf([parakeet])), undefined)
  assert.equal(
    cacheLayoutFor(parakeet, 'macos', byPathOf([parakeet, ...encoder.slice(1)])),
    undefined
  )
  const ctc = {
    ...parakeet,
    registryPath: 'qvac_models_compiled/ggml/parakeet/2026-01-01/parakeet-ctc-0.6b.q4_0.gguf'
  }
  assert.equal(coremlSetFor(ctc, 'macos', complete), undefined, 'a stem with no bundles')
})

test('an hf Core ML family roots its set at the model directory', () => {
  const root = 'qvac/TranscribePsy-250M-EU-sub-coreml/resolve/abc/'
  const psy = {
    ...single,
    registrySource: 'hf',
    registryPath: `${root}transcribepsy-250m-eu-sub-coreml.gguf`
  }
  const encoderPart = COMPONENTS.map((component) => ({
    ...single,
    registrySource: 'hf',
    registryPath: `${root}transcribepsy-250m-eu-sub-coreml-encoder.mlmodelc/${component}`
  }))
  assert.equal(
    coremlSetFor(psy, 'macos', byPathOf([psy, ...encoderPart])).setKey,
    shortHash(`hf:${psy.registryPath}:coreml:${root}`)
  )
})

test('the Core ML mirror still matches the SDK family table', () => {
  // packages/inference is the source; a moved root, a new stem or bundle must be mirrored here.
  const source = readFileSync(
    fileURLToPath(
      new URL('../../../inference/src/handlers/load-model/coreml-sidecars.ts', import.meta.url)
    ),
    'utf8'
  )
  const families = source.slice(
    source.indexOf('const SIDECAR_FAMILIES'),
    source.indexOf('type CompanionSet')
  )
  const quoted = (pattern, text) => [...text.matchAll(pattern)].map((match) => match[1]).sort()

  assert.deepEqual(
    quoted(/root: '([^']+)'/g, families),
    COREML_FAMILIES.flatMap((family) => (family.root ? [family.root] : [])).sort()
  )
  assert.deepEqual(
    quoted(/source: '([^']+)'/g, families),
    COREML_FAMILIES.map((family) => family.source).sort()
  )
  // Each stem with its bundles, in order: `stem|sourceName|targetSuffix`.
  const bundlesInSource = [...families.matchAll(/^ {6}'?([\w.-]+)'?: \[([\s\S]*?)\]/gm)]
    .flatMap(([, stem, body]) =>
      [...body.matchAll(/sourceName: '([^']+)',\s*targetSuffix: '([^']*)'/g)].map(
        ([, sourceName, targetSuffix]) => `${stem}|${sourceName}|${targetSuffix}`
      )
    )
    .sort()
  const bundlesMirrored = COREML_FAMILIES.flatMap((family) =>
    Object.entries(family.bundlesByStem).flatMap(([stem, bundles]) =>
      bundles.map((bundle) => `${stem}|${bundle.sourceName}|${bundle.targetSuffix}`)
    )
  ).sort()
  assert.ok(bundlesInSource.length > 0, 'the source table was parsed')
  assert.deepEqual(bundlesInSource, bundlesMirrored)
  for (const family of COREML_FAMILIES) {
    assert.ok(families.includes(`pathPattern: ${family.pathPattern}`), String(family.pathPattern))
    assert.ok(families.includes(`stemPattern: ${family.stemPattern}`), String(family.stemPattern))
  }
  const components = source.slice(
    source.indexOf('const COREML_COMPONENTS'),
    source.indexOf('] as const')
  )
  assert.deepEqual(quoted(/'([^']+)'/g, components), [...COMPONENTS].sort())
})

test('the shard filename pattern still matches the SDK detectShardedModel', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../inference/src/utils/shard-utils.ts', import.meta.url)),
    'utf8'
  )
  assert.ok(source.includes(`const shardPattern = ${SHARD_FILENAME}`), String(SHARD_FILENAME))
})

test('the plan prefixes the cache root, merges aliases and reports unknown constants', () => {
  const plan = buildModelCachePlan({
    constants: [
      { constant: { name: 'LLAMA' }, owners: ['llm'] },
      {
        constant: {
          name: 'LLAMA_ALIAS',
          registryPath: single.registryPath,
          registrySource: single.registrySource
        },
        owners: ['llm-batch']
      },
      { constant: { name: 'MISSING' }, owners: ['x'] }
    ],
    registry: [single],
    os: 'linux',
    cacheRoot: 'packages/sdk-e2e/.qvac-cache/'
  })
  const file = `packages/sdk-e2e/.qvac-cache/${shortHash(single.registryPath)}_llama-q4_0.gguf`
  assert.equal(plan.entries.length, 1)
  assert.deepEqual(plan.entries[0].paths, [file])
  assert.deepEqual(plan.entries[0].files, [
    { path: file, size: single.expectedSize, sha256: single.sha256Checksum }
  ])
  assert.deepEqual(plan.entries[0].models, ['LLAMA', 'LLAMA_ALIAS'])
  assert.deepEqual(plan.entries[0].owners, ['llm', 'llm-batch'])
  assert.deepEqual(plan.unresolved, ['MISSING'])
})

test('the plan prefixes Core ML files with the cache root', () => {
  const plan = buildModelCachePlan({
    constants: [{ constant: { name: 'PARAKEET' }, owners: ['asr'] }],
    registry: [parakeet, ...encoder],
    os: 'macos',
    cacheRoot: 'c'
  })
  const [entry] = plan.entries
  assert.match(entry.paths[0], /^c\/sets\/[0-9a-f]{16}$/)
  assert.equal(entry.files.length, 1 + COMPONENTS.length)
  assert.ok(entry.files.every((file) => file.path.startsWith(`${entry.paths[0]}/`)))
})

test('an unplannable model is listed as unresolved', () => {
  const unknownShards = {
    ...single,
    name: 'SHARDS',
    registryPath: 'qvac_models_compiled/ggml/big/2026-01-01/big-00001-of-00004.gguf'
  }
  assert.equal(cacheLayoutFor(unknownShards, 'linux'), undefined)
  const plan = buildModelCachePlan({
    constants: [{ constant: { name: 'SHARDS' }, owners: ['x'] }],
    registry: [unknownShards],
    os: 'linux',
    cacheRoot: 'c'
  })
  assert.deepEqual(plan.unresolved, ['SHARDS'])
  // Shard metadata on a filename the SDK does not treat as sharded is ignored, as the SDK does.
  const flat = cacheLayoutFor({ ...single, shardMetadata: [] }, 'linux')
  assert.deepEqual(flat.paths, [`${shortHash(single.registryPath)}_llama-q4_0.gguf`])
})

test('a Core ML set wins over a companion set on macOS, as in the SDK', () => {
  const both = { ...parakeet, companionSet: { setKey: 'generic', files: [] } }
  const byPath = byPathOf([both, ...encoder])
  assert.notDeepEqual(cacheLayoutFor(both, 'macos', byPath).paths, ['sets/generic'])
  assert.deepEqual(cacheLayoutFor(both, 'linux', byPath).paths, ['sets/generic'])
})

test('every planned entry passes the cache action validation, key included', () => {
  const companion = {
    ...single,
    name: 'COMPANION',
    registryPath: 'x/companion.bin',
    companionSet: {
      setKey: 'k1',
      files: [
        { targetName: 'z.bin', expectedSize: 1, sha256Checksum: sha('z') },
        { targetName: 'A.bin', expectedSize: 2, sha256Checksum: sha('A') }
      ]
    }
  }
  const plan = buildModelCachePlan({
    constants: ['LLAMA', 'COMPANION', 'PARAKEET'].map((name) => ({
      constant: { name },
      owners: [name]
    })),
    registry: [single, companion, parakeet, ...encoder],
    os: 'macos',
    cacheRoot: 'packages/sdk-e2e/.qvac-cache'
  })
  assert.equal(plan.entries.length, 3)
  assert.doesNotThrow(() =>
    validatePlan({ version: 1, cacheRoot: 'packages/sdk-e2e/.qvac-cache', ...plan })
  )
})

test('merging plans keeps one entry per path set', () => {
  const entry = (models, owners) => ({
    contentId: 'c',
    paths: ['root/x'],
    files: [{ path: 'root/x', size: 1, sha256: 'c' }],
    expectedSize: 1,
    models,
    owners
  })
  const merged = mergeModelCacheEntries([[entry(['A'], ['a'])], [entry(['A', 'B'], ['b'])]])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].models, ['A', 'B'])
  assert.deepEqual(merged[0].owners, ['a', 'b'])
})

test('bootstrap deps: the producer list wins, then the CI plan, else everything', () => {
  const tests = [{ testId: 't', metadata: { dependency: 'llm+ocr' } }]
  assert.deepEqual(
    [...resolveBootstrapDeps(tests, { QVAC_E2E_BOOTSTRAP_DEPS: '["x"]' })],
    ['llm', 'ocr']
  )
  assert.deepEqual(
    [...resolveBootstrapDeps(undefined, { QVAC_E2E_BOOTSTRAP_DEPS: '["x","y"]' })],
    ['x', 'y']
  )
  assert.equal(resolveBootstrapDeps(undefined, { QVAC_E2E_BOOTSTRAP_DEPS: '[]' }).size, 0)
  assert.equal(resolveBootstrapDeps(undefined, {}), undefined)
  assert.throws(() => resolveBootstrapDeps(undefined, { QVAC_E2E_BOOTSTRAP_DEPS: 'llm' }))
  assert.throws(() => resolveBootstrapDeps(undefined, { QVAC_E2E_BOOTSTRAP_DEPS: '[1]' }))
})

test('bootstrap models: a JSON list of names, or no limit', () => {
  assert.deepEqual([...resolveBootstrapModels({ QVAC_E2E_BOOTSTRAP_MODELS: '["A"]' })], ['A'])
  assert.equal(resolveBootstrapModels({ QVAC_E2E_BOOTSTRAP_MODELS: '' }), undefined)
  assert.equal(resolveBootstrapModels({}), undefined)
  assert.throws(() => resolveBootstrapModels({ QVAC_E2E_BOOTSTRAP_MODELS: 'A,B' }))
})
