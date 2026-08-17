'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  benchmarkModelsByTest,
  resolvePinnedManifest,
  normalizeManifest,
  expandPrestageList,
  buildScript
} = require('../generate-prestage-block')
const {
  matrix,
  modelFileName,
  runFunctionName,
  workflowBatches
} = require('../../test/integration/_benchmark-matrix')
const mobileManifest = require('../../test/mobile/model-manifest.json')
const integrationManifest = require('../../test/integration/models.manifest.json')

test('resolvePinnedManifest replaces mobile URLs with pinned integration URLs', () => {
  const resolved = resolvePinnedManifest(
    {
      runExampleTest: [
        {
          name: 'model.gguf',
          url: 'https://huggingface.co/example/model/resolve/main/model.gguf'
        }
      ]
    },
    {
      models: {
        ...integrationManifest.models,
        'model.gguf': {
          urls: [
            'https://huggingface.co/example/model/resolve/0123456789012345678901234567890123456789/model.gguf'
          ]
        }
      }
    }
  )

  assert.equal(
    resolved.runExampleTest[0].url,
    'https://huggingface.co/example/model/resolve/0123456789012345678901234567890123456789/model.gguf'
  )
})

test('resolvePinnedManifest rejects missing or mutable integration URLs', () => {
  const mobile = {
    runExampleTest: [{ name: 'model.gguf', url: 'https://example.com/model.gguf' }]
  }

  assert.throws(
    () => resolvePinnedManifest(mobile, { models: integrationManifest.models }),
    /model\.gguf has no usable pinned manifest URL/
  )
  assert.throws(
    () =>
      resolvePinnedManifest(mobile, {
        models: {
          ...integrationManifest.models,
          'model.gguf': {
            urls: ['https://huggingface.co/example/model/resolve/main/model.gguf']
          }
        }
      }),
    /model\.gguf has no usable pinned manifest URL/
  )
})

test('PRESTAGE_URL_MAP overrides win and bypass the HF-shape check', () => {
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-prestage-')), 'map.json')
  const usUrl = 'https://tether-ai-dev-us.s3.us-west-2.amazonaws.com/x/model.gguf?sig=abc'
  fs.writeFileSync(mapPath, JSON.stringify({ 'model.gguf': usUrl }))
  const prev = process.env.PRESTAGE_URL_MAP
  process.env.PRESTAGE_URL_MAP = mapPath
  try {
    const resolved = resolvePinnedManifest(
      {
        runExampleTest: [
          {
            name: 'model.gguf',
            url: 'https://huggingface.co/example/model/resolve/main/model.gguf'
          }
        ]
      },
      // model.gguf only has a mutable /resolve/main URL, so it fails the HF-shape
      // check unless the override supplies the US-bucket URL. Real benchmark models
      // still resolve from their pinned integration URLs.
      {
        models: {
          ...integrationManifest.models,
          'model.gguf': { urls: ['https://huggingface.co/example/model/resolve/main/model.gguf'] }
        }
      }
    )
    assert.equal(resolved.runExampleTest[0].url, usUrl)
  } finally {
    if (prev === undefined) delete process.env.PRESTAGE_URL_MAP
    else process.env.PRESTAGE_URL_MAP = prev
    fs.rmSync(path.dirname(mapPath), { recursive: true, force: true })
  }
})

test('real mobile models all resolve to pinned integration URLs', () => {
  const resolved = resolvePinnedManifest(mobileManifest, integrationManifest)

  for (const models of Object.values(resolved)) {
    for (const model of models) {
      assert.equal(model.url, integrationManifest.models[model.name].urls[0])
      assert.doesNotMatch(model.url, /\/resolve\/(?:main|master)\//)
    }
  }
})

test('every benchmark model derived from the matrix is fully pinned', () => {
  const modelNames = new Set(matrix().map((cell) => modelFileName(cell.size, cell.quant)))

  assert.equal(modelNames.size, 10)
  for (const name of modelNames) {
    const entry = integrationManifest.models[name]
    assert.ok(entry, `${name} is present in the integration manifest`)
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, `${name} has a byte pin`)
    assert.ok(Array.isArray(entry.urls) && entry.urls.length > 0, `${name} has a URL`)
    for (const url of entry.urls) {
      assert.match(url, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//)
    }
  }
})

test('every generated benchmark grep name maps to its matrix model', () => {
  const benchmarkModels = benchmarkModelsByTest()

  assert.equal(Object.keys(benchmarkModels).length, matrix().length)
  for (const cell of matrix()) {
    assert.deepEqual(benchmarkModels[runFunctionName(cell)], [
      { name: modelFileName(cell.size, cell.quant) }
    ])
  }
  for (const batch of workflowBatches()) {
    for (const group of batch.groups) {
      assert.ok(benchmarkModels[group.grep], `${group.grep} has a pre-stage mapping`)
    }
  }
})

test('buildScript embeds the resolved manifest (android default)', () => {
  const encoded = Buffer.from('{"runExampleTest":[]}').toString('base64')
  const script = buildScript(encoded)

  assert.match(script, new RegExp(encoded))
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /missing benchmark mapping/)
  assert.match(script, /adb push/)
  assert.doesNotMatch(script, /pymobiledevice3/)
})

test('buildScript ios backend uses pymobiledevice3 apps push into Documents', () => {
  const encoded = Buffer.from('{"runExampleTest":[]}').toString('base64')
  const script = buildScript(encoded, 'ios')

  assert.match(script, new RegExp(encoded))
  assert.match(script, /missing benchmark mapping/)
  assert.match(script, /pymobiledevice3 apps push/)
  assert.match(script, /Documents\/\$NAME/)
  assert.match(script, /unset SUDO_UID SUDO_GID/)
  assert.match(script, /not found during afc operation\|failed to perform afc operation/)
  assert.match(script, /pymobiledevice3==10\.3\.1/)
  assert.doesNotMatch(script, /adb push/)
  assert.doesNotMatch(script, /PRESTAGE_DIR=\/data\/local\/tmp/)
})

test('buildScript rejects unknown platforms', () => {
  assert.throws(() => buildScript('e30=', 'windows'), /unknown platform/)
})

test('normalizeManifest stores each URL once and maps tests to names', () => {
  const shared = 'https://us-bucket.example/presigned/shared.gguf?sig=abc'
  const { urls, fallbacks, tests } = normalizeManifest({
    runA: [{ name: 'shared.gguf', url: shared }],
    runB: [
      { name: 'shared.gguf', url: shared },
      { name: 'only-b.gguf', url: 'https://us-bucket.example/presigned/b.gguf?sig=def' }
    ]
  })

  assert.deepEqual(Object.keys(urls).sort(), ['only-b.gguf', 'shared.gguf'])
  assert.equal(urls['shared.gguf'], shared)
  assert.deepEqual(fallbacks, {})
  assert.deepEqual(tests, { runA: ['shared.gguf'], runB: ['shared.gguf', 'only-b.gguf'] })
})

test('normalize -> expand carries the upstream fallback through to the row', () => {
  const presigned = 'https://us-bucket.example/presigned/m.gguf?sig=abc'
  const upstream = 'https://huggingface.co/x/y/resolve/deadbeef/m.gguf'
  const normalized = normalizeManifest({
    runA: [{ name: 'm.gguf', url: presigned, fallback: upstream }]
  })

  assert.deepEqual(normalized.fallbacks, { 'm.gguf': upstream })
  assert.deepEqual(expandPrestageList(normalized, 'runA'), [
    { name: 'm.gguf', url: presigned, fallback: upstream }
  ])
})

test('commonPrelude writes the optional fallback as a third tsv column', () => {
  const script = buildScript(Buffer.from('{"urls":{},"tests":{}}').toString('base64'))
  assert.match(script, /r\.fallback\?/)
  assert.match(script, /read -r NAME URL FALLBACK/)
  assert.match(script, /used fallback/)
})

test('normalize -> expand round-trips each shard to its {name,url} rows', () => {
  const resolved = {
    runA: [{ name: 'shared.gguf', url: 'u://shared' }],
    runB: [
      { name: 'shared.gguf', url: 'u://shared' },
      { name: 'only-b.gguf', url: 'u://b' }
    ]
  }
  const normalized = normalizeManifest(resolved)

  assert.deepEqual(expandPrestageList(normalized, 'runA'), [
    { name: 'shared.gguf', url: 'u://shared' }
  ])
  assert.deepEqual(expandPrestageList(normalized, 'runB'), [
    { name: 'shared.gguf', url: 'u://shared' },
    { name: 'only-b.gguf', url: 'u://b' }
  ])
  // No grep => every test, deduped across shards (shared.gguf appears once).
  assert.deepEqual(expandPrestageList(normalized, ''), [
    { name: 'shared.gguf', url: 'u://shared' },
    { name: 'only-b.gguf', url: 'u://b' }
  ])
})

test('expandPrestageList honours a multi-test grep and dedupes overlap', () => {
  const normalized = normalizeManifest({
    runA: [{ name: 'shared.gguf', url: 'u://shared' }],
    runB: [{ name: 'shared.gguf', url: 'u://shared' }],
    runC: [{ name: 'only-c.gguf', url: 'u://c' }]
  })

  assert.deepEqual(expandPrestageList(normalized, 'runA | runB'), [
    { name: 'shared.gguf', url: 'u://shared' }
  ])
})

test('expandPrestageList throws when a benchmark shard has no mapping', () => {
  const normalized = normalizeManifest({ runOther: [{ name: 'm.gguf', url: 'u://m' }] })

  assert.throws(
    () => expandPrestageList(normalized, 'runBenchmarkPerf_1b_q4'),
    /missing benchmark mapping/
  )
})

test('commonPrelude embeds expandPrestageList verbatim (no host/CI drift)', () => {
  const script = buildScript(Buffer.from('{"urls":{},"tests":{}}').toString('base64'))
  assert.match(script, /const expandPrestageList=function expandPrestageList/)
  assert.match(script, /prestage-list\.tsv/)
})
