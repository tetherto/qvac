'use strict'

/**
 * Unit tests for the pure selection / script helpers in
 * scripts/generate-prestage-block.js.
 *
 * Guards the mobile LavaSR prestage wiring: an engine-only row must keep its
 * exact (pre-LavaSR) prestage list, an enhancer/denoiser row must additionally
 * push only the requested LavaSR GGUF into the `lavasr/` subdir, and the emitted
 * host script must create that subdir on both the host and the device.
 *
 * Pure-function code paths only — requiring the module does not read the
 * manifest or write stdout (main() is guarded by require.main === module).
 *
 * Run locally:
 *   node --test scripts/__tests__/generate-prestage-block.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const mobileGroups = require('../../test/mobile/test-groups.json')

const {
  resolveVariant,
  requestedLavasrKinds,
  lavasrEntries,
  qualityEntries,
  selectEntries,
  functionalModelsByTest,
  selectFunctionalEntries,
  buildTsv,
  buildPrestageScript,
  buildIosPrestageScript,
  buildPlatformScript,
  buildFunctionalSelectionCode,
  buildFunctionalPrestageScript,
  buildPrestageBlock,
  buildFunctionalPrestageBlock,
  readOptionsFromEnv,
  PRESTAGE_DIR,
  IOS_MODELS_ROOT,
  IOS_MODELS_PARENT,
  IOS_MODELS_BASENAME
} = require('../generate-prestage-block')

const MANIFEST = {
  q4: [
    { name: 'supertonic-q4_0.gguf', targetName: 'supertonic.gguf', url: 'https://s3/s-q4.gguf' }
  ],
  q8: [
    { name: 'supertonic-q8_0.gguf', targetName: 'supertonic.gguf', url: 'https://s3/s-q8.gguf' }
  ],
  lavasr: [
    {
      name: 'lavasr-enhancer-f16.gguf',
      targetName: 'lavasr/lavasr-enhancer.gguf',
      url: 'https://s3/enh.gguf'
    },
    {
      name: 'lavasr-denoiser-f16.gguf',
      targetName: 'lavasr/lavasr-denoiser.gguf',
      url: 'https://s3/den.gguf'
    }
  ],
  cosyvoice: [
    {
      name: 'cosyvoice3-llm-q8_0.gguf',
      targetName: 'cosyvoice3/cosyvoice3-llm-q8_0.gguf',
      url: 'https://s3/cv-llm.gguf'
    },
    {
      name: 'cosyvoice3-flow-f32.gguf',
      targetName: 'cosyvoice3/cosyvoice3-flow-f32.gguf',
      url: 'https://s3/cv-flow.gguf'
    },
    {
      name: 'cosyvoice3-hift-f32.gguf',
      targetName: 'cosyvoice3/cosyvoice3-hift-f32.gguf',
      url: 'https://s3/cv-hift.gguf'
    },
    {
      name: 'voice-en.gguf',
      targetName: 'cosyvoice3/voice.gguf',
      url: 'https://s3/cv-voice.gguf'
    },
    {
      name: 'vocab.json',
      targetName: 'cosyvoice3/vocab.json',
      url: 'https://s3/vocab.json'
    },
    {
      name: 'merges.txt',
      targetName: 'cosyvoice3/merges.txt',
      url: 'https://s3/merges.txt'
    }
  ],
  quality: [
    {
      name: 'ggml-tiny.bin',
      targetName: 'whisper/ggml-tiny.bin',
      url: 'https://hf/ggml-tiny.bin'
    }
  ]
}

const FUNCTIONAL_MANIFEST = {
  ...MANIFEST,
  functional: [
    {
      name: 'supertonic3-f16.gguf',
      targetName: 'supertonic3-f16.gguf',
      url: 'https://s3/s3-f16.gguf'
    },
    {
      name: 'supertonic3-f32.gguf',
      targetName: 'supertonic3-f32.gguf',
      url: 'https://s3/s3-f32.gguf'
    },
    {
      name: 'supertonic3-q8_0.gguf',
      targetName: 'supertonic3-q8_0.gguf',
      url: 'https://s3/s3-q8.gguf'
    },
    {
      name: 'supertonic3-q4_0.gguf',
      targetName: 'supertonic3-q4_0.gguf',
      url: 'https://s3/s3-q4.gguf'
    }
  ],
  q4: MANIFEST.q4.concat([
    {
      name: 'chatterbox-t3-turbo-q4_0.gguf',
      targetName: 'chatterbox-t3-turbo.gguf',
      url: 'https://s3/cb-t3.gguf'
    },
    {
      name: 'chatterbox-s3gen-q4_0.gguf',
      targetName: 'chatterbox-s3gen.gguf',
      url: 'https://s3/cb-s3.gguf'
    },
    {
      name: 'chatterbox-t3-mtl-q4_0.gguf',
      targetName: 'chatterbox-t3-mtl.gguf',
      url: 'https://s3/cb-mtl-t3.gguf'
    },
    {
      name: 'chatterbox-s3gen-mtl-q4_0.gguf',
      targetName: 'chatterbox-s3gen-mtl.gguf',
      url: 'https://s3/cb-mtl-s3.gguf'
    },
    {
      name: 'supertonic2-q4_0.gguf',
      targetName: 'supertonic2.gguf',
      url: 'https://s3/s2-q4.gguf'
    }
  ]),
  parler: [
    {
      name: 'parler-mini-v1-q8_0.gguf',
      targetName: 'parler-mini-v1-q8_0.gguf',
      url: 'https://s3/parler-q8.gguf'
    }
  ]
}

function decodeBlockTsv(block) {
  const match = block.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)
  assert.ok(match, 'prestage block embeds a base64 TSV')
  return Buffer.from(match[1], 'base64').toString('utf8')
}

function assertBashSyntax(script) {
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

test('resolveVariant lowercases and validates, defaulting to q4', () => {
  assert.equal(resolveVariant('q4'), 'q4')
  assert.equal(resolveVariant('Q8'), 'q8')
  assert.equal(resolveVariant(undefined), 'q4')
  assert.equal(resolveVariant(''), 'q4')
  assert.throws(() => resolveVariant('f16'), /Unsupported variant/)
})

test('requestedLavasrKinds maps only the axes that are on', () => {
  assert.deepEqual(requestedLavasrKinds({ enhancer: 'none', denoiser: 'none' }), [])
  assert.deepEqual(requestedLavasrKinds({ enhancer: 'lavasr', denoiser: 'none' }), ['enhancer'])
  assert.deepEqual(requestedLavasrKinds({ enhancer: 'none', denoiser: 'lavasr' }), ['denoiser'])
  assert.deepEqual(requestedLavasrKinds({ enhancer: 'lavasr', denoiser: 'lavasr' }), [
    'enhancer',
    'denoiser'
  ])
})

test('lavasrEntries returns only the manifest entries for the requested axes', () => {
  assert.deepEqual(lavasrEntries(MANIFEST, { enhancer: 'none', denoiser: 'none' }), [])
  assert.deepEqual(
    lavasrEntries(MANIFEST, { enhancer: 'lavasr', denoiser: 'none' }).map((e) => e.targetName),
    ['lavasr/lavasr-enhancer.gguf']
  )
  assert.deepEqual(
    lavasrEntries(MANIFEST, { enhancer: 'none', denoiser: 'lavasr' }).map((e) => e.targetName),
    ['lavasr/lavasr-denoiser.gguf']
  )
})

test('lavasrEntries is empty when the manifest has no lavasr section', () => {
  assert.deepEqual(lavasrEntries({ q4: [] }, { enhancer: 'lavasr', denoiser: 'lavasr' }), [])
})

test('qualityEntries selects the Whisper model only when quality is enabled', () => {
  assert.deepEqual(qualityEntries(MANIFEST, false), [])
  assert.deepEqual(qualityEntries(MANIFEST, true), MANIFEST.quality)
})

test('selectEntries keeps an engine-only row byte-identical to pre-LavaSR', () => {
  const engineOnly = selectEntries(MANIFEST, { variant: 'q4', enhancer: 'none', denoiser: 'none' })
  assert.deepEqual(engineOnly, MANIFEST.q4)
})

test('selectEntries pushes the fixed cosyvoice group when the row is a cosyvoice row', () => {
  const cosyvoice = selectEntries(MANIFEST, {
    variant: 'q8',
    engine: 'cosyvoice',
    enhancer: 'none',
    denoiser: 'none'
  })
  assert.deepEqual(
    cosyvoice.map((e) => e.targetName),
    [
      'cosyvoice3/cosyvoice3-llm-q8_0.gguf',
      'cosyvoice3/cosyvoice3-flow-f32.gguf',
      'cosyvoice3/cosyvoice3-hift-f32.gguf',
      'cosyvoice3/voice.gguf',
      'cosyvoice3/vocab.json',
      'cosyvoice3/merges.txt'
    ]
  )
})

test('selectEntries ignores variant for a cosyvoice row (q4 and q8 stage the same group)', () => {
  const q4 = selectEntries(MANIFEST, { variant: 'q4', engine: 'cosyvoice' })
  const q8 = selectEntries(MANIFEST, { variant: 'q8', engine: 'cosyvoice' })
  assert.deepEqual(q4, q8)
  assert.deepEqual(q4, MANIFEST.cosyvoice)
})

test('selectEntries keeps a non-cosyvoice engine on the variant path unchanged', () => {
  const chatterbox = selectEntries(MANIFEST, {
    variant: 'q4',
    engine: 'chatterbox',
    enhancer: 'none',
    denoiser: 'none'
  })
  assert.deepEqual(chatterbox, MANIFEST.q4)
})

test('selectEntries appends only the requested LavaSR GGUF after the engine models', () => {
  const withEnhancer = selectEntries(MANIFEST, {
    variant: 'q4',
    enhancer: 'lavasr',
    denoiser: 'none'
  })
  assert.deepEqual(
    withEnhancer.map((e) => e.targetName),
    ['supertonic.gguf', 'lavasr/lavasr-enhancer.gguf']
  )

  const withBoth = selectEntries(MANIFEST, {
    variant: 'q4',
    enhancer: 'lavasr',
    denoiser: 'lavasr'
  })
  assert.deepEqual(
    withBoth.map((e) => e.targetName),
    ['supertonic.gguf', 'lavasr/lavasr-enhancer.gguf', 'lavasr/lavasr-denoiser.gguf']
  )
})

test('selectEntries appends the mobile Whisper model when quality is enabled', () => {
  const entries = selectEntries(MANIFEST, {
    variant: 'q4',
    enhancer: 'none',
    denoiser: 'none',
    quality: true
  })
  assert.deepEqual(
    entries.map((entry) => entry.targetName),
    ['supertonic.gguf', 'whisper/ggml-tiny.bin']
  )
})

test('functionalModelsByTest maps each functional runner to only its required staged models', () => {
  const modelsByTest = functionalModelsByTest(FUNCTIONAL_MANIFEST)

  assert.deepEqual(
    modelsByTest.runAddonTest.map((entry) => entry.targetName),
    ['chatterbox-t3-turbo.gguf', 'chatterbox-s3gen.gguf']
  )
  assert.deepEqual(
    modelsByTest.runChatterboxMtlTest.map((entry) => entry.targetName),
    ['chatterbox-t3-mtl.gguf', 'chatterbox-s3gen-mtl.gguf']
  )
  assert.deepEqual(
    modelsByTest.runSupertonicTest.map((entry) => entry.targetName),
    ['supertonic.gguf']
  )
  assert.deepEqual(
    modelsByTest.runParlerTest.map((entry) => entry.targetName),
    ['parler-mini-v1-q8_0.gguf']
  )
  assert.deepEqual(
    modelsByTest.runCosyvoice3Test.map((entry) => entry.targetName),
    [
      'cosyvoice3/cosyvoice3-llm-q8_0.gguf',
      'cosyvoice3/cosyvoice3-flow-f32.gguf',
      'cosyvoice3/cosyvoice3-hift-f32.gguf',
      'cosyvoice3/voice.gguf',
      'cosyvoice3/vocab.json',
      'cosyvoice3/merges.txt'
    ]
  )
  // The gpu smoke runs every engine's GPU leg, so its prestage list must
  // carry the CosyVoice3 artifacts too — the on-device registry fetch of the
  // ~2.3 GB set is exactly the Device Farm flake this mapping prevents.
  for (const target of [
    'cosyvoice3/cosyvoice3-llm-q8_0.gguf',
    'cosyvoice3/cosyvoice3-flow-f32.gguf',
    'cosyvoice3/cosyvoice3-hift-f32.gguf',
    'cosyvoice3/voice.gguf',
    'cosyvoice3/vocab.json',
    'cosyvoice3/merges.txt'
  ]) {
    assert.ok(
      modelsByTest.runGpuSmokeTest.some((entry) => entry.targetName === target),
      `runGpuSmokeTest prestage must include ${target}`
    )
  }
  assert.deepEqual(
    modelsByTest.runLavasrEnhancerTest.map((entry) => entry.targetName),
    [
      'chatterbox-t3-turbo.gguf',
      'chatterbox-s3gen.gguf',
      'supertonic.gguf',
      'lavasr/lavasr-enhancer.gguf'
    ]
  )
  assert.deepEqual(
    modelsByTest.runCosyvoice3LavasrTest.map((entry) => entry.targetName),
    [
      'cosyvoice3/cosyvoice3-llm-q8_0.gguf',
      'cosyvoice3/cosyvoice3-flow-f32.gguf',
      'cosyvoice3/cosyvoice3-hift-f32.gguf',
      'cosyvoice3/voice.gguf',
      'cosyvoice3/vocab.json',
      'cosyvoice3/merges.txt',
      'lavasr/lavasr-enhancer.gguf',
      'lavasr/lavasr-denoiser.gguf'
    ]
  )
  assert.deepEqual(
    modelsByTest.runSupertonic3QuantTest.map((entry) => entry.targetName),
    [
      'supertonic3-f16.gguf',
      'supertonic3-f32.gguf',
      'supertonic3-q8_0.gguf',
      'supertonic3-q4_0.gguf'
    ]
  )
})

test('functional prestage mappings cover every configured mobile shard runner', () => {
  const mappings = functionalModelsByTest(FUNCTIONAL_MANIFEST)
  const configured = Object.values(mobileGroups.android).flat()
  assert.deepEqual(Object.keys(mappings).sort(), configured.sort())
})

test('selectFunctionalEntries regex-matches runner names and deduplicates shared targets', () => {
  const mappings = functionalModelsByTest(FUNCTIONAL_MANIFEST)
  const entries = selectFunctionalEntries(mappings, 'runAddonTest|runMultipleRunsTest')

  assert.deepEqual(
    entries.map((entry) => entry.targetName),
    ['chatterbox-t3-turbo.gguf', 'chatterbox-s3gen.gguf', 'supertonic.gguf']
  )

  // The grep is a mocha --grep regex over runner NAMES: a partial pattern
  // stages every runner it matches, not just an exact manifest key.
  const chatterbox = selectFunctionalEntries(mappings, 'runChatterboxSpeed')
  assert.deepEqual(
    chatterbox.map((entry) => entry.targetName),
    ['chatterbox-t3-turbo.gguf', 'chatterbox-s3gen.gguf']
  )

  // An empty grep is benign (no shard resolved -> stage nothing). A zero-match
  // typo or an invalid regex is a test-groups <-> model-map drift and fails
  // CLOSED: the workflow_call lanes never run validate-devices, so an
  // under-staged run must surface here.
  assert.deepEqual(selectFunctionalEntries(mappings, ''), [])
  assert.deepEqual(
    selectFunctionalEntries(mappings, 'runParlerTest').map((entry) => entry.targetName),
    ['parler-mini-v1-q8_0.gguf']
  )
  assert.throws(
    () => selectFunctionalEntries(mappings, 'runMissingTest'),
    /matched no known runner/
  )
  assert.throws(() => selectFunctionalEntries(mappings, '('), /invalid tests grep/)
})

test('functional mapping fails when any required manifest target is absent', () => {
  assert.throws(
    () =>
      functionalModelsByTest({
        ...FUNCTIONAL_MANIFEST,
        functional: FUNCTIONAL_MANIFEST.functional.slice(1)
      }),
    /Missing Supertonic 3 manifest target/
  )
  assert.throws(
    () => functionalModelsByTest({ ...FUNCTIONAL_MANIFEST, lavasr: [] }),
    /Missing LavaSR manifest target/
  )
  assert.throws(
    () => functionalModelsByTest({ ...FUNCTIONAL_MANIFEST, parler: [] }),
    /Missing Parler manifest target/
  )
})

test('functional prestage script reads the explicit shard grep and deduplicates targets', () => {
  const script = buildFunctionalPrestageScript('QkFTRTY0')

  assert.ok(script.startsWith('set -euo pipefail\n'))
  assertBashSyntax(script)
  assert.match(script, /cat \/tmp\/qvacShardGrep\.txt/)
  assert.doesNotMatch(script, /wdio\.config\.devicefarm\.js/)
  assert.match(script, /no functional shard grep/)
  assert.match(script, /matched no known runner/)
  assert.match(script, /seen\.has\(m\.targetName\)/)
  assert.match(script, /adb push/)
})

test('functional selector executes deduplication and stages the Parler shard GGUF', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tts-functional-prestage-'))
  const manifestPath = join(directory, 'manifest.json')
  const listPath = join(directory, 'list.tsv')
  const mappings = functionalModelsByTest(FUNCTIONAL_MANIFEST)
  writeFileSync(manifestPath, JSON.stringify(mappings))

  const run = (grep) =>
    spawnSync(process.execPath, ['-e', buildFunctionalSelectionCode()], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GREP: grep,
        FUNCTIONAL_MANIFEST_PATH: manifestPath,
        FUNCTIONAL_LIST_PATH: listPath
      }
    })

  const shared = run('runAddonTest|runMultipleRunsTest')
  assert.equal(shared.status, 0, shared.stderr)
  assert.equal(
    readFileSync(listPath, 'utf8'),
    [
      'chatterbox-t3-turbo.gguf\thttps://s3/cb-t3.gguf',
      'chatterbox-s3gen.gguf\thttps://s3/cb-s3.gguf',
      'supertonic.gguf\thttps://s3/s-q4.gguf',
      ''
    ].join('\n')
  )

  // A partial regex stages every matching runner's models on device too.
  const partial = run('runChatterboxSpeed')
  assert.equal(partial.status, 0, partial.stderr)
  assert.equal(
    readFileSync(listPath, 'utf8'),
    [
      'chatterbox-t3-turbo.gguf\thttps://s3/cb-t3.gguf',
      'chatterbox-s3gen.gguf\thttps://s3/cb-s3.gguf',
      ''
    ].join('\n')
  )

  // A typo that matches no known runner is drift and fails CLOSED on device
  // (non-zero exit) so a validate-devices-less workflow_call run cannot silently
  // ship under-staged.
  const typo = run('runNopeTest')
  assert.notEqual(typo.status, 0)
  assert.match(typo.stderr, /matched no known runner/)

  // Parler stages its single GGUF like every other runner — it used to be the
  // one on-device downloader and its registry fetch was the CI timeout flake.
  const parler = run('runParlerTest')
  assert.equal(parler.status, 0, parler.stderr)
  assert.equal(
    readFileSync(listPath, 'utf8'),
    'parler-mini-v1-q8_0.gguf\thttps://s3/parler-q8.gguf\n'
  )
  rmSync(directory, { recursive: true, force: true })
})

test('functional prestage block embeds CosyVoice and LavaSR mappings without staging all models', () => {
  const block = buildFunctionalPrestageBlock(FUNCTIONAL_MANIFEST)
  const match = block.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)
  assert.ok(match)
  const mappings = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))

  assert.deepEqual(
    mappings.runParlerTest.map((entry) => entry.targetName),
    ['parler-mini-v1-q8_0.gguf']
  )
  assert.ok(
    mappings.runCosyvoice3Test.some(
      (entry) => entry.targetName === 'cosyvoice3/cosyvoice3-llm-q8_0.gguf'
    )
  )
  assert.ok(
    mappings.runLavasrEnhancerTest.some(
      (entry) => entry.targetName === 'lavasr/lavasr-enhancer.gguf'
    )
  )
  assert.ok(
    !mappings.runSupertonicTest.some((entry) => entry.targetName.startsWith('chatterbox-'))
  )
})

test('buildTsv emits one tab-separated targetName/url line per entry', () => {
  assert.equal(
    buildTsv([
      { targetName: 'a.gguf', url: 'u1' },
      { targetName: 'lavasr/b.gguf', url: 'u2' }
    ]),
    'a.gguf\tu1\nlavasr/b.gguf\tu2\n'
  )
})

test('buildPrestageScript makes the per-target subdir on host and device', () => {
  const script = buildPrestageScript('QkFTRTY0', 'q4')
  assert.ok(script.startsWith('set -euo pipefail\n'))
  assertBashSyntax(script)
  assert.ok(script.includes(`PRESTAGE_DIR=${PRESTAGE_DIR}`), 'pins the on-device prestage dir')
  assert.ok(
    script.includes('mkdir -p "/tmp/prestage/$(dirname "$TARGET")"'),
    'creates the host-side subdir'
  )
  assert.ok(
    script.includes('adb shell mkdir -p "$PRESTAGE_DIR/$(dirname "$TARGET")"'),
    'creates the device-side subdir so nested lavasr/ targets push cleanly'
  )
})

test('buildIosPrestageScript stages into the Documents/models container via pymobiledevice3', () => {
  const script = buildIosPrestageScript('QkFTRTY0', 'q4')
  assert.ok(script.includes(`MODELS_ROOT=${IOS_MODELS_ROOT}`), 'pins the iOS models root')
  assert.ok(script.includes('unset SUDO_UID SUDO_GID'), 'works around the chown EPERM')
  assert.ok(
    script.includes('pymobiledevice3 apps push "$BID" "/tmp/prestage/$TARGET" "$MODELS_ROOT/$TARGET"'),
    'pushes each target under Documents/models via AFC'
  )
  assert.ok(
    script.includes('mkdir -p "/tmp/prestage/$(dirname "$TARGET")"'),
    'creates the host-side subdir so nested lavasr/ + whisper/ targets download cleanly'
  )
  assert.ok(
    /not found during afc operation\|failed to perform afc operation/.test(script),
    'AFC error-token backstop covers the AfcFileNotFoundError phrasing older CLIs log on a still-zero exit'
  )
  assert.ok(/pymobiledevice3==10\.3\.1/.test(script), 'pins pymobiledevice3 to the fail-closed version')
  assert.ok(!script.includes('adb '), 'iOS backend uses no adb')
  assert.ok(!script.includes(PRESTAGE_DIR), 'iOS backend does not touch the Android prestage dir')
})

// Regression: AfcService._push_internal only makedirs() on the *directory*
// push branch. A single-file push whose remote parent (Documents/models) is
// missing raises AfcFileNotFoundError instead of creating it, so every
// tts-ggml target used to hard-fail on a fresh container. The fix seeds the
// device dir tree once via a directory push before the per-file loop.
test('buildIosPrestageScript seeds the device dir tree with a directory push before staging files', () => {
  const script = buildIosPrestageScript('QkFTRTY0', 'q4')
  assert.ok(script.includes(`MODELS_PARENT=${IOS_MODELS_PARENT}`), 'pins the models root parent')
  assert.ok(
    script.includes(`SCAFFOLD_DIR=/tmp/prestage-scaffold/${IOS_MODELS_BASENAME}`),
    'names a local scaffold dir whose basename matches the models root'
  )
  assert.ok(
    script.includes('pymobiledevice3 apps push "$BID" "$SCAFFOLD_DIR" "$MODELS_PARENT"'),
    'pushes the scaffold directory (not a file) so AFC takes the makedirs branch'
  )

  const seedIdx = script.indexOf('pymobiledevice3 apps push "$BID" "$SCAFFOLD_DIR" "$MODELS_PARENT"')
  const firstFilePushIdx = script.indexOf(
    'pymobiledevice3 apps push "$BID" "/tmp/prestage/$TARGET" "$MODELS_ROOT/$TARGET"'
  )
  assert.ok(seedIdx > -1 && firstFilePushIdx > -1 && seedIdx < firstFilePushIdx, 'seeds the tree before any per-file push')

  assert.ok(
    script.includes('printf \'%s\\n\' "$SEED_OUT"') &&
      /SEED_RC.*-ne 0.*traceback\|afcexception/.test(script.replace(/\n/g, ' ')),
    'fails hard on a non-zero exit or AFC error token from the seed push, mirroring the per-file guard'
  )
})

test('buildIosPrestageScript derives scaffold subdirs from the selected targets, not a hardcoded list', () => {
  const flatOnly = Buffer.from('supertonic.gguf\thttps://s3/s-q4.gguf\n', 'utf8').toString('base64')
  const flatScript = buildIosPrestageScript(flatOnly, 'q4')
  assert.ok(
    !/mkdir -p "\$SCAFFOLD_DIR\/lavasr"/.test(flatScript) &&
      !/mkdir -p "\$SCAFFOLD_DIR\/whisper"/.test(flatScript),
    'does not hardcode lavasr/whisper subdirs — an engine-only manifest has none to seed'
  )
  assert.ok(
    flatScript.includes('[ "$SUBDIR" != "." ] && mkdir -p "$SCAFFOLD_DIR/$SUBDIR"'),
    'still seeds whatever nested subdir a future manifest target introduces'
  )
})

test('buildPlatformScript selects the backend by platform and rejects unknown ones', () => {
  assert.ok(buildPlatformScript('QkFTRTY0', 'q4', 'android').includes('adb push'))
  assert.ok(buildPlatformScript('QkFTRTY0', 'q4', 'ios').includes('pymobiledevice3 apps push'))
  assert.throws(() => buildPlatformScript('QkFTRTY0', 'q4', 'windows'), /unknown platform/)
})

test('buildPrestageBlock ios backend stages the lavasr GGUF under Documents/models', () => {
  const block = buildPrestageBlock(
    MANIFEST,
    { variant: 'q4', enhancer: 'lavasr', denoiser: 'none' },
    'ios'
  )
  const tsv = decodeBlockTsv(block)
  assert.ok(tsv.includes('supertonic.gguf\thttps://s3/s-q4.gguf'), 'engine model still staged')
  assert.ok(
    tsv.includes('lavasr/lavasr-enhancer.gguf\thttps://s3/enh.gguf'),
    'enhancer staged into the lavasr/ subdir (resolved on-device under models/lavasr)'
  )
  assert.ok(block.includes('pymobiledevice3 apps push'), 'emits the iOS AFC push backend')
  assert.ok(!block.includes('adb push'), 'no adb in the iOS block')
})

test('buildPrestageBlock for an engine-only row stages no lavasr files', () => {
  const block = buildPrestageBlock(MANIFEST, { variant: 'q4', enhancer: 'none', denoiser: 'none' })
  const tsv = decodeBlockTsv(block)
  assert.equal(tsv, 'supertonic.gguf\thttps://s3/s-q4.gguf\n')
  assert.ok(!tsv.includes('lavasr/'), 'no lavasr GGUF staged for an engine-only row')
})

test('buildPrestageBlock for a lavasr row stages the engine model and the enhancer', () => {
  const block = buildPrestageBlock(MANIFEST, {
    variant: 'q4',
    enhancer: 'lavasr',
    denoiser: 'none'
  })
  const tsv = decodeBlockTsv(block)
  assert.ok(tsv.includes('supertonic.gguf\thttps://s3/s-q4.gguf'), 'engine model still staged')
  assert.ok(
    tsv.includes('lavasr/lavasr-enhancer.gguf\thttps://s3/enh.gguf'),
    'enhancer staged into the lavasr/ subdir'
  )
  assert.ok(!tsv.includes('lavasr-denoiser'), 'denoiser not staged when only enhancer is on')
})

test('readOptionsFromEnv defaults the LavaSR axes to none and quality to enabled', () => {
  assert.deepEqual(readOptionsFromEnv({ TTS_GGML_MOBILE_BENCHMARK_VARIANT: 'q8' }), {
    variant: 'q8',
    engine: 'chatterbox',
    enhancer: 'none',
    denoiser: 'none',
    quality: true
  })
  assert.deepEqual(
    readOptionsFromEnv({
      TTS_GGML_MOBILE_BENCHMARK_VARIANT: 'q4',
      TTS_GGML_MOBILE_BENCHMARK_ENHANCER: 'lavasr',
      TTS_GGML_MOBILE_BENCHMARK_DENOISER: 'lavasr'
    }),
    { variant: 'q4', engine: 'chatterbox', enhancer: 'lavasr', denoiser: 'lavasr', quality: true }
  )
  assert.equal(readOptionsFromEnv({ TTS_GGML_MOBILE_BENCHMARK_QUALITY: 'false' }).quality, false)
})

test('readOptionsFromEnv reads the engine axis (default chatterbox)', () => {
  assert.equal(readOptionsFromEnv({}).engine, 'chatterbox')
  assert.equal(
    readOptionsFromEnv({ TTS_GGML_MOBILE_BENCHMARK_ENGINE: 'cosyvoice' }).engine,
    'cosyvoice'
  )
})
