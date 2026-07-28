'use strict'

/**
 * Unit tests for the vla-ggml model pre-stage block generator.
 * Pure parse/build logic — no adb, no network.
 *
 * Run locally:
 *   node --test packages/vla-ggml/scripts/__tests__/generate-prestage-block.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MODEL_SHARDS, buildManifest, buildScript } = require('../generate-prestage-block')

function withAssetsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vla-prestage-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('buildManifest maps each shard test fn to its model + presigned url', () => {
  withAssetsDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'smolvla-urls.json'),
      JSON.stringify({ modelUrl: 'https://s3.example.com/smolvla.gguf?sig=a', sizeBytes: 1 })
    )
    fs.writeFileSync(
      path.join(dir, 'groot-urls.json'),
      JSON.stringify({ modelUrl: 'https://s3.example.com/groot.gguf?sig=b' })
    )
    const man = buildManifest(dir)
    assert.deepEqual(man.runAddonTest, [
      { name: 'smolvla-libero-vision-q8.gguf', url: 'https://s3.example.com/smolvla.gguf?sig=a' }
    ])
    assert.deepEqual(man.runGrootTest, [
      { name: 'groot-q5_vf16.gguf', url: 'https://s3.example.com/groot.gguf?sig=b' }
    ])
    // pi05 is deferred on mobile — it must never appear in the manifest.
    assert.ok(!('runPi05Test' in man))
  })
})

test('buildManifest drops shards with missing/non-https configs', () => {
  withAssetsDir((dir) => {
    assert.deepEqual(buildManifest(dir), {})
    // Only smolvla present, groot missing -> only smolvla in the manifest.
    fs.writeFileSync(
      path.join(dir, 'smolvla-urls.json'),
      JSON.stringify({ modelUrl: 'https://ok/smolvla.gguf' })
    )
    fs.writeFileSync(path.join(dir, 'groot-urls.json'), JSON.stringify({ modelUrl: 'ftp://nope' }))
    const man = buildManifest(dir)
    assert.deepEqual(Object.keys(man), ['runAddonTest'])
  })
})

test('MODEL_SHARDS excludes pi05 (deferred on mobile)', () => {
  assert.deepEqual(MODEL_SHARDS.map((s) => s.test).sort(), ['runAddonTest', 'runGrootTest'])
})

test('buildScript reads the shard grep and stages only matching models via adb', () => {
  const man = { runAddonTest: [{ name: 'smolvla.gguf', url: 'https://x/smolvla.gguf' }] }
  const b64 = Buffer.from(JSON.stringify(man)).toString('base64')
  const script = buildScript(b64)
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /wdio\.config\.devicefarm\.js/)
  assert.match(script, /shard grep/)
  assert.match(script, new RegExp(b64.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
  assert.match(script, /adb push/)
  assert.match(script, /\[prestage\] done/)
})
