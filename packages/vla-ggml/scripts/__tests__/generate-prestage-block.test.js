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
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  MODEL_SHARDS,
  buildManifest,
  buildScript,
  formatYamlBlock
} = require('../generate-prestage-block')

function withAssetsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vla-prestage-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function runWithStubs(
  script,
  { adbExit = 0, curlExit = 0, mkdirExit = null, grep = 'runAddonTest' }
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vla-prestage-shell-'))
  const binDir = path.join(dir, 'bin')
  const testsDir = path.join(dir, 'tests')
  fs.mkdirSync(binDir)
  fs.mkdirSync(testsDir)
  fs.writeFileSync(path.join(binDir, 'adb'), `#!/bin/sh\nexit ${adbExit}\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'curl'), `#!/bin/sh\nexit ${curlExit}\n`, { mode: 0o755 })
  if (mkdirExit !== null) {
    fs.writeFileSync(path.join(binDir, 'mkdir'), `#!/bin/sh\nexit ${mkdirExit}\n`, { mode: 0o755 })
  }
  fs.writeFileSync(
    path.join(testsDir, 'wdio.config.devicefarm.js'),
    // Double quotes: upload-to-devicefarm JSON-encodes the grep into the wdio
    // config, so the prestage extractor must read a double-quoted value (a
    // single-quote-only regex would silently stage the whole manifest).
    `exports.config = { mochaOpts: { grep: ${JSON.stringify(grep)} } }\n`
  )
  try {
    return childProcess.spawnSync('sh', ['-c', script], {
      cwd: dir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8'
    })
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

test('buildScript reads the shard grep and stages only matching models via adb on Android', () => {
  const man = { runAddonTest: [{ name: 'smolvla.gguf', url: 'https://x/smolvla.gguf' }] }
  const b64 = Buffer.from(JSON.stringify(man)).toString('base64')
  const script = buildScript(b64)
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /wdio\.config\.devicefarm\.js/)
  assert.match(script, /shard grep/)
  assert.match(script, new RegExp(b64.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
  assert.match(script, /adb push/)
  assert.match(script, /device will use network fallback/)
  assert.match(script, /matched no known runner \(test-groups <-> model-map drift\)/)
  assert.match(script, /\[prestage\] done/)
  const syntax = childProcess.spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  const failedDownload = runWithStubs(script, { curlExit: 22 })
  assert.equal(failedDownload.status, 0, failedDownload.stderr)
  assert.match(failedDownload.stdout, /device will use network fallback/)
  const failedAdb = runWithStubs(script, { adbExit: 1 })
  assert.equal(failedAdb.status, 0, failedAdb.stderr)
  assert.match(failedAdb.stdout, /adb setup failed/)
  const failedTempSetup = runWithStubs(script, { mkdirExit: 1 })
  assert.equal(failedTempSetup.status, 0, failedTempSetup.stderr)
  assert.match(failedTempSetup.stdout, /host temp setup failed/)
})

test('shard grep is a regex: partial matches stage, an unbaked-but-known shard falls back, a drift typo fails closed', () => {
  const man = {
    runAddonTest: [{ name: 'smolvla.gguf', url: 'https://x/smolvla.gguf' }],
    runGrootTest: [{ name: 'groot.gguf', url: 'https://x/groot.gguf' }]
  }
  const script = buildScript(Buffer.from(JSON.stringify(man)).toString('base64'))

  // The count/warn lines are on stderr (console.error); staging + fallback
  // notices are on stdout (echo). Assert against the combined stream.
  const out = (r) => `${r.stdout}${r.stderr}`

  // Partial regex "runGroot" used to find no exact key and stage nothing; it
  // must now match runGrootTest and stage its model.
  const partial = runWithStubs(script, { grep: 'runGroot' })
  assert.equal(partial.status, 0, partial.stderr)
  assert.match(out(partial), /1 model\(s\) for 1 test\(s\)/)
  assert.match(out(partial), /staging groot\.gguf/)

  // Alternation selects both shards.
  const both = runWithStubs(script, { grep: 'runAddonTest|runGrootTest' })
  assert.equal(both.status, 0, both.stderr)
  assert.match(out(both), /2 model\(s\) for 2 test\(s\)/)

  // A grep that matches a KNOWN runner whose presigned URL is not baked yet
  // (or the mobile-deferred pi05) is NOT drift: warn and let the device fall
  // back to the network. Manifest here has no runGrootTest key.
  const unbaked = buildScript(
    Buffer.from(JSON.stringify({ runAddonTest: man.runAddonTest })).toString('base64')
  )
  const missingUrl = runWithStubs(unbaked, { grep: 'runGrootTest' })
  assert.equal(missingUrl.status, 0, missingUrl.stderr)
  assert.match(out(missingUrl), /known runner with no baked URL yet/)
  assert.match(out(missingUrl), /0 model\(s\) for 0 test\(s\)/)

  // A typo that matches NO known runner is a test-groups <-> model-map drift.
  // The workflow_call lanes never run validate-devices, so this must fail
  // closed on device rather than silently ship an under-staged run.
  const typo = runWithStubs(script, { grep: 'runNope' })
  assert.notEqual(typo.status, 0)
  assert.match(out(typo), /matched no known runner \(test-groups <-> model-map drift\)/)
})

test('buildScript ios backend uses pymobiledevice3 apps push into Documents', () => {
  const man = { runAddonTest: [{ name: 'smolvla.gguf', url: 'https://x/smolvla.gguf' }] }
  const b64 = Buffer.from(JSON.stringify(man)).toString('base64')
  const script = buildScript(b64, 'ios')
  assert.match(script, /wdio\.config\.devicefarm\.js/)
  assert.match(script, /shard grep/)
  assert.match(script, new RegExp(b64.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
  assert.match(script, /pymobiledevice3 apps push/)
  assert.match(script, /Documents\/\$NAME/)
  assert.match(script, /unset SUDO_UID SUDO_GID/)
  assert.match(script, /--max-time 3600/)
  assert.match(script, /not found during afc operation\|failed to perform afc operation/)
  assert.match(script, /pymobiledevice3==10\.3\.1/)
  assert.match(script, /device will use network fallback/)
  assert.doesNotMatch(script, /adb push/)
  assert.doesNotMatch(script, /PRESTAGE_DIR=\/data\/local\/tmp/)
  assert.match(script, /matched no known runner \(test-groups <-> model-map drift\)/)
  const syntax = childProcess.spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('buildScript rejects unknown platforms', () => {
  assert.throws(() => buildScript('e30=', 'windows'), /unknown platform/)
})

test('formatYamlBlock emits a literal block with every shell line indented', () => {
  assert.equal(formatYamlBlock('set -e\necho ok'), '|\n  set -e\n  echo ok\n')
})
