/**
 * Windows e2e pins `@qvac/inference` via `toLocalTarballSpec`. A bare
 * `C:/…tgz` path is not a valid bun/npm spec and is not skipped by
 * `enforce-inference-versions` (`file:`/`link:`/`npm:` only). Unix already
 * emits a `file:` URL. The win32 branch must too, as `file:C:/…` rather
 * than WHATWG `file:///C:/…` (rejected by bun/npm on Windows).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toLocalTarballSpec as inferenceSpec } from '../../actions/sdk-e2e-prepare-inference/prepare.mjs'
import { toLocalTarballSpec as suiteSpec } from '../../actions/sdk-e2e-prepare-test-suite/prepare.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const WIN32_TARBALL =
  'C:\\actions-runner-2\\_work\\_temp\\qvac-inference-0.19.1.tgz'
const WIN32_SPEC =
  'file:C:/actions-runner-2/_work/_temp/qvac-inference-0.19.1.tgz'
const WIN32_RETURN =
  /return `file:\$\{path\.win32\.resolve\(tarballPath\)\.replaceAll\(/

const COPIES = [
  '.github/actions/sdk-e2e-prepare-inference/prepare.mjs',
  '.github/actions/sdk-e2e-prepare-test-suite/prepare.mjs',
  'packages/sdk/e2e/scripts/build-local-inference.mjs'
]

test('win32 emits file: + posixified drive path, not a WHATWG file URL', () => {
  assert.equal(inferenceSpec(WIN32_TARBALL, 'win32'), WIN32_SPEC)
  assert.equal(suiteSpec(WIN32_TARBALL, 'win32'), WIN32_SPEC)
  assert.ok(WIN32_SPEC.startsWith('file:'))
  assert.ok(!WIN32_SPEC.startsWith('file:///'))
})

test('unix still emits a WHATWG file URL', () => {
  const spec = inferenceSpec('/tmp/qvac-inference-0.19.1.tgz', 'linux')
  assert.equal(suiteSpec('/tmp/qvac-inference-0.19.1.tgz', 'linux'), spec)
  assert.ok(spec.startsWith('file:///'))
  assert.ok(spec.endsWith('/qvac-inference-0.19.1.tgz'))
})

test('every toLocalTarballSpec copy uses the file: win32 form', () => {
  for (const relative of COPIES) {
    const source = readFileSync(join(ROOT, relative), 'utf8')
    assert.match(source, WIN32_RETURN, `${relative} must emit file: on win32`)
  }
})
