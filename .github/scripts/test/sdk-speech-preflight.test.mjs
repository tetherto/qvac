import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PACKAGES,
  validateRun,
  validateSources,
  applyOverrides,
  prepareSpeechPreflight,
  verifySpeechPreflight
} from '../../../packages/sdk/ci/speech-preflight.mjs'

const CONFIG = {
  repository: 'tetherto/qvac',
  sourceSha: 'a'.repeat(40),
  workflow: '.github/workflows/cache-warm.yml'
}
const RUN = {
  repository: { full_name: CONFIG.repository },
  head_sha: CONFIG.sourceSha,
  path: CONFIG.workflow,
  event: 'workflow_dispatch'
}
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value))

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'speech-preflight-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('accepts the pinned native build and rejects a different revision, repository or workflow', () => {
  assert.doesNotThrow(() => validateRun(RUN, CONFIG))
  assert.throws(() => validateRun({ ...RUN, head_sha: 'b'.repeat(40) }, CONFIG), /provenance/)
  assert.throws(
    () => validateRun({ ...RUN, repository: { full_name: 'someone/qvac' } }, CONFIG),
    /provenance/
  )
  assert.throws(() => validateRun({ ...RUN, path: 'other.yml' }, CONFIG), /provenance/)
  assert.throws(() => validateRun({ ...RUN, event: 'pull_request' }, CONFIG), /provenance/)
})

test('without the opt-in manifest, the ordinary SDK installation remains unchanged', (t) => {
  assert.equal(prepareSpeechPreflight(temporary(t), {}), null)
})

test('rejects changed native sources, renamed source files and truncated comparisons', () => {
  assert.doesNotThrow(() =>
    validateSources({ status: 'ahead', files: [{ filename: 'packages/sdk/ci/e2e.mjs' }] })
  )
  assert.throws(
    () =>
      validateSources({ status: 'ahead', files: [{ filename: 'packages/asr-ggml/binding.js' }] }),
    /sources differ/
  )
  assert.throws(
    () =>
      validateSources({
        status: 'ahead',
        files: [{ filename: 'elsewhere.js', previous_filename: 'packages/asr-ggml/binding.js' }]
      }),
    /sources differ/
  )
  assert.throws(
    () =>
      validateSources({
        status: 'ahead',
        files: Array.from({ length: 300 }, () => ({ filename: 'docs/file.md' }))
      }),
    /sources differ/
  )
  assert.throws(() => validateSources({ status: 'behind', files: [] }), /sources differ/)
})

test('overrides also replace direct dependencies to avoid npm EOVERRIDE', (t) => {
  const file = join(temporary(t), 'package.json')
  writeJson(file, {
    dependencies: { '@qvac/asr-ggml': '^0.12.0', untouched: '^1.0.0' },
    overrides: { existing: '1.0.0' }
  })
  applyOverrides(file, [{ name: '@qvac/asr-ggml', spec: 'file:/tmp/asr.tgz' }])
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(manifest.dependencies['@qvac/asr-ggml'], 'file:/tmp/asr.tgz')
  assert.equal(manifest.overrides['@qvac/asr-ggml'], 'file:/tmp/asr.tgz')
  assert.equal(manifest.dependencies.untouched, '^1.0.0')
  assert.equal(manifest.overrides.existing, '1.0.0')
})

function installPackage(root, slug) {
  const directory = join(root, 'node_modules/@qvac', slug)
  mkdirSync(join(directory, 'prebuilds'), { recursive: true })
  writeJson(join(directory, 'package.json'), {
    name: `@qvac/${slug}`,
    exports: { './package': './package.json' }
  })
  writeFileSync(join(directory, 'prebuilds/runtime.bare'), slug)
  return {
    name: `@qvac/${slug}`,
    integrity: `sha512-${slug}`,
    native: [{ name: 'runtime.bare', hash: createHash('sha512').update(slug).digest('base64') }]
  }
}

function installation(t) {
  const root = temporary(t)
  mkdirSync(join(root, 'node_modules/@qvac/sdk'), { recursive: true })
  writeJson(join(root, 'node_modules/@qvac/sdk/package.json'), { name: '@qvac/sdk' })
  const packages = PACKAGES.map((slug) => installPackage(root, slug))
  writeJson(join(root, 'package-lock.json'), {
    packages: Object.fromEntries(
      packages.map((p) => [`node_modules/${p.name}`, { integrity: p.integrity }])
    )
  })
  return { root, provenance: { ...CONFIG, host: 'linux-x64', packages } }
}

test('checks installed tarballs and native payloads before writing provenance', (t) => {
  const { root, provenance } = installation(t)
  verifySpeechPreflight(root, provenance)
  assert.equal(
    JSON.parse(readFileSync(join(root, 'reports/speech-preflight-provenance.json'))).sourceSha,
    CONFIG.sourceSha
  )
  writeFileSync(join(root, 'node_modules/@qvac/asr-ggml/prebuilds/runtime.bare'), 'old binary')
  assert.throws(() => verifySpeechPreflight(root, provenance), /native payload differs/)
})

test('rejects published npm fallback and a separately resolved Fabric runtime', (t) => {
  const { root, provenance } = installation(t)
  const altered = structuredClone(provenance)
  altered.packages[0].integrity = 'sha512-published'
  assert.throws(() => verifySpeechPreflight(root, altered), /unexpected tarball/)
  installPackage(join(root, 'node_modules/@qvac/asr-ggml'), 'fabric')
  assert.throws(() => verifySpeechPreflight(root, provenance), /separate Fabric/)
})
