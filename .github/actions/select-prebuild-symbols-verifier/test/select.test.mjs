// Guards the choice of symbol verifier for a prebuild. A wrong answer either
// fails a valid backport (the current verifier cannot find an older fabric's
// runtime) or skips the provider lookup a newer addon needs, so the cutoffs and
// the fail-closed paths matter more than the parsing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_VERIFIER,
  main,
  parseVersion,
  selectVerifier,
  validateManifest,
} from '../select.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = join(HERE, '..', 'verifiers.json')
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
const REUSABLE_PREBUILDS = join(HERE, '..', '..', '..', 'workflows', 'reusable-prebuilds.yml')

function withWorkdir(pkg, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'select-verifier-'))
  try {
    if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function run(env, manifestPath = MANIFEST_PATH) {
  const lines = []
  const log = { log: (line) => lines.push(line) }
  return withOutput((outputPath) => {
    const code = main({ env: { ...env, GITHUB_OUTPUT: outputPath }, log, manifestPath })
    return { code, lines, output: readFileSync(outputPath, 'utf8') }
  })
}

function withOutput(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'select-verifier-out-'))
  const outputPath = join(dir, 'output')
  writeFileSync(outputPath, '')
  try {
    return fn(outputPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the shipped manifest is valid', () => {
  assert.doesNotThrow(() => validateManifest(MANIFEST))
})

// An id without a matching step would leave that addon's prebuild with no
// symbol check and a green run.
test('reusable-prebuilds.yml runs a verify step for every verifier id', () => {
  const workflow = readFileSync(REUSABLE_PREBUILDS, 'utf8')
  for (const id of MANIFEST.verifiers) {
    assert.ok(
      workflow.includes(`steps.symbols-verifier.outputs.verifier == '${id}'`),
      `reusable-prebuilds.yml has no verify step for '${id}'`,
    )
  }
})

test('a backport on fabric 0.20 or earlier gets the fabric-0.20 verifier', () => {
  assert.equal(selectVerifier(MANIFEST, { name: '@qvac/embed-llamacpp', version: '0.43.2' }), 'fabric-0.20')
  assert.equal(selectVerifier(MANIFEST, { name: '@qvac/embed-llamacpp', version: '0.46.1' }), 'fabric-0.20')
})

test('the first release on fabric 0.21 and later get the current verifier', () => {
  assert.equal(selectVerifier(MANIFEST, { name: '@qvac/embed-llamacpp', version: '0.47.0' }), 'current')
  assert.equal(selectVerifier(MANIFEST, { name: '@qvac/embed-llamacpp', version: '0.48.0' }), 'current')
})

test('a prerelease is placed by its x.y.z core', () => {
  assert.equal(selectVerifier(MANIFEST, { name: '@qvac/llm-llamacpp', version: '0.59.0-rc.1' }), 'fabric-0.20')
  assert.equal(selectVerifier(MANIFEST, { name: '@qvac/llm-llamacpp', version: '0.60.0-rc.1' }), 'current')
})

test('an unlisted addon gets the current verifier', () => {
  assert.equal(selectVerifier(MANIFEST, { name: '@qvac/tts-ggml', version: '0.1.0' }), DEFAULT_VERIFIER)
})

test('ranges are matched in order, so later ranges cover newer layouts', () => {
  const manifest = validateManifest({
    verifiers: ['current', 'old', 'mid'],
    addons: {
      '@qvac/x': [
        { below: '1.0.0', verifier: 'old' },
        { below: '2.0.0', verifier: 'mid' },
      ],
    },
  })
  assert.equal(selectVerifier(manifest, { name: '@qvac/x', version: '0.9.9' }), 'old')
  assert.equal(selectVerifier(manifest, { name: '@qvac/x', version: '1.5.0' }), 'mid')
  assert.equal(selectVerifier(manifest, { name: '@qvac/x', version: '2.0.0' }), 'current')
})

test('a listed addon with an unparseable version fails instead of guessing', () => {
  assert.throws(() => selectVerifier(MANIFEST, { name: '@qvac/embed-llamacpp', version: 'next' }), /unparseable version/)
})

test('the manifest rejects an unknown verifier id', () => {
  assert.throws(
    () => validateManifest({ verifiers: ['current'], addons: { '@qvac/x': [{ below: '1.0.0', verifier: 'nope' }] } }),
    /unknown verifier 'nope'/,
  )
})

test('the manifest rejects a missing current verifier, bad versions and unordered ranges', () => {
  assert.throws(() => validateManifest({ verifiers: ['old'], addons: {} }), /'current'/)
  assert.throws(
    () => validateManifest({ verifiers: ['current', 'old'], addons: { '@qvac/x': [{ below: 'soon', verifier: 'old' }] } }),
    /invalid 'below'/,
  )
  assert.throws(
    () =>
      validateManifest({
        verifiers: ['current', 'old'],
        addons: {
          '@qvac/x': [
            { below: '2.0.0', verifier: 'old' },
            { below: '1.0.0', verifier: 'old' },
          ],
        },
      }),
    /ascending/,
  )
})

test('parseVersion accepts x.y.z with optional prefix and suffix only', () => {
  assert.deepEqual(parseVersion('0.43.2'), [0, 43, 2])
  assert.deepEqual(parseVersion('v1.2.3+build'), [1, 2, 3])
  assert.equal(parseVersion('1.2'), null)
  assert.equal(parseVersion(undefined), null)
})

test('main writes the selected verifier to GITHUB_OUTPUT', () => {
  withWorkdir({ name: '@qvac/embed-llamacpp', version: '0.43.2' }, (dir) => {
    const { code, output, lines } = run({ WORKDIR: dir })
    assert.equal(code, 0)
    assert.equal(output, 'verifier=fabric-0.20\n')
    assert.match(lines.join('\n'), /@qvac\/embed-llamacpp@0\.43\.2: fabric-0\.20/)
  })
})

test('main falls back to the current verifier without a package.json', () => {
  withWorkdir(null, (dir) => {
    const { code, output } = run({ WORKDIR: dir })
    assert.equal(code, 0)
    assert.equal(output, 'verifier=current\n')
  })
})

test('main fails and writes no output on an invalid manifest', () => {
  withWorkdir({ name: '@qvac/x', version: '1.0.0' }, (dir) => {
    const manifestPath = join(dir, 'bad.json')
    writeFileSync(manifestPath, JSON.stringify({ verifiers: ['current'], addons: { '@qvac/x': [{ below: '2.0.0', verifier: 'gone' }] } }))
    const { code, output, lines } = run({ WORKDIR: dir }, manifestPath)
    assert.equal(code, 1)
    assert.equal(output, '')
    assert.match(lines.join('\n'), /::error::.*unknown verifier 'gone'/)
  })
})

test('main fails without WORKDIR', () => {
  const { code, output } = run({})
  assert.equal(code, 1)
  assert.equal(output, '')
})
