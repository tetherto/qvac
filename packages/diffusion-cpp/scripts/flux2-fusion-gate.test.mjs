import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptsDir, '..')
const repoDir = path.resolve(packageDir, '..', '..')
const workflow = fs.readFileSync(
  path.join(repoDir, '.github/workflows/integration-test-diffusion-cpp.yml'),
  'utf8'
)
const fusionTest = fs.readFileSync(
  path.join(packageDir, 'test/integration/generate-image-flux2-fusion.test.js'),
  'utf8'
)
const surjectiveFusionTest = fs.readFileSync(
  path.join(packageDir, 'test/integration/generate-image-flux2-fusion-surjective.test.js'),
  'utf8'
)
const i2iTest = fs.readFileSync(
  path.join(packageDir, 'test/integration/generate-image-flux2-i2i.test.js'),
  'utf8'
)
const gateHelper = fs.readFileSync(path.join(packageDir, 'test/integration/flux2-gate.js'), 'utf8')
const mobileSelection = fs.readFileSync(
  path.join(packageDir, 'test/mobile/integration.auto.cjs'),
  'utf8'
)

test('FLUX2 fusion gate targets only the Apple Paravirtual matrix leg', () => {
  const targetMatrixEntry = [
    '          - os: mac-mini-m4',
    '            platform: darwin',
    '            arch: arm64',
    '            runner: macos-26-xlarge',
    "            ltx: 'true'",
    "            skip_flux2_fusion: 'true'"
  ].join('\n')

  assert.match(workflow, new RegExp(targetMatrixEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(
    (workflow.match(/skip_flux2_fusion: 'true'/g) || []).length,
    1,
    'the opt-out must not broaden to another matrix leg'
  )
  assert.match(workflow, /SKIP_FLUX2_FUSION: \$\{\{ matrix\.skip_flux2_fusion \|\| 'false' \}\}/)
})

test('all FLUX2 integration tests consume the shared scoped gate', () => {
  assert.match(gateHelper, /GITHUB_ACTIONS === 'true'/)
  assert.match(gateHelper, /RUNNER_ENVIRONMENT === 'github-hosted'/)
  assert.match(gateHelper, /os\.platform\(\) === 'darwin'[\s\S]*os\.arch\(\) === 'arm64'/)
  assert.match(gateHelper, /SKIP_FLUX2_FUSION === 'true'/)
  assert.match(gateHelper, /Apple Paravirtual Metal/)
  assert.match(gateHelper, /MUL_MAT/)
  for (const testSource of [fusionTest, surjectiveFusionTest, i2iTest]) {
    assert.match(testSource, /require\('\.\/flux2-gate'\)/)
    assert.match(testSource, /getFlux2Skip\(/)
  }
  assert.match(
    mobileSelection,
    /runIntegrationModule\('\.\.\/integration\/generate-image-flux2-fusion\.test\.js', options\)/
  )
  assert.match(
    mobileSelection,
    /runIntegrationModule\('\.\.\/integration\/generate-image-flux2-fusion-surjective\.test\.js', options\)/
  )
  assert.match(
    mobileSelection,
    /runIntegrationModule\('\.\.\/integration\/generate-image-flux2-i2i\.test\.js', options\)/
  )
})
