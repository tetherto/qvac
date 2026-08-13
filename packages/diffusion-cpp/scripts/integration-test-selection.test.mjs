import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { selectIntegrationTests } from './generate-integration-tests.mjs'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptsDir, '..')
const repoDir = path.resolve(packageDir, '..', '..')
const integrationDir = path.join(packageDir, 'test', 'integration')
const testFiles = fs
  .readdirSync(integrationDir)
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => path.posix.join('test', 'integration', file))
const flux2Files = testFiles.filter((file) => /flux2/i.test(path.basename(file)))
const nonFlux2Files = testFiles.filter((file) => !/flux2/i.test(path.basename(file)))
const workflow = fs.readFileSync(
  path.join(repoDir, '.github/workflows/integration-test-diffusion-cpp.yml'),
  'utf8'
)
const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))

function select({ env = {}, platform = 'linux', arch = 'x64' } = {}) {
  return selectIntegrationTests(testFiles, { env, platform, arch })
}

function assertAllTestsSelected(selection) {
  assert.deepEqual(selection.selected, testFiles)
  assert.deepEqual(selection.skipped, [])
  assert.equal(selection.reason, null)
}

function assertOnlyFlux2Skipped(selection) {
  assert.deepEqual(selection.skipped, flux2Files)
  assert.deepEqual(selection.selected, nonFlux2Files)
}

test('default selection includes every FLUX2 integration test', () => {
  assert.ok(flux2Files.length >= 5, 'expected all current FLUX2 tests in the fixture')
  assert.ok(nonFlux2Files.length > 0, 'expected non-FLUX2 tests in the fixture')
  assertAllTestsSelected(select())
})

test('SKIP_FLUX2=true excludes every FLUX2 test and no other test', () => {
  const selection = select({ env: { SKIP_FLUX2: 'true' } })

  assert.equal(selection.reason, 'SKIP_FLUX2=true')
  assertOnlyFlux2Skipped(selection)
})

test('GitHub-hosted Darwin arm64 fallback excludes every FLUX2 test', () => {
  const selection = select({
    env: {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted'
    },
    platform: 'darwin',
    arch: 'arm64'
  })

  assert.equal(selection.reason, 'GitHub-hosted Darwin arm64 runner')
  assertOnlyFlux2Skipped(selection)
})

test('self-hosted Darwin arm64 retains every FLUX2 test', () => {
  assertAllTestsSelected(
    select({
      env: {
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'self-hosted'
      },
      platform: 'darwin',
      arch: 'arm64'
    })
  )
})

test('other operating systems and architectures retain every FLUX2 test', () => {
  const githubHosted = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted'
  }

  assertAllTestsSelected(select({ env: githubHosted, platform: 'darwin', arch: 'x64' }))
  assertAllTestsSelected(select({ env: githubHosted, platform: 'linux', arch: 'arm64' }))
  assertAllTestsSelected(select({ env: githubHosted, platform: 'win32', arch: 'x64' }))
})

test('workflow scopes SKIP_FLUX2 to the macos-26-xlarge matrix leg', () => {
  const oldGateName = ['SKIP', 'FLUX2', 'FUSION'].join('_')
  const targetMatrixEntry = [
    '          - os: mac-mini-m4',
    '            platform: darwin',
    '            arch: arm64',
    '            runner: macos-26-xlarge',
    "            ltx: 'true'",
    "            skip_flux2: 'true'"
  ].join('\n')

  assert.ok(workflow.includes(targetMatrixEntry))
  assert.equal((workflow.match(/skip_flux2: 'true'/g) || []).length, 1)
  assert.match(workflow, /SKIP_FLUX2: \$\{\{ matrix\.skip_flux2 \|\| 'false' \}\}/)
  assert.equal(workflow.includes(oldGateName), false)
  assert.equal(workflow.includes(oldGateName.toLowerCase()), false)
})

test('package scripts use the unified selector and old per-test gates are gone', () => {
  assert.equal(
    packageJson.scripts['test:integration:generate'],
    'node scripts/generate-integration-tests.mjs && npm run test:mobile:generate'
  )
  assert.equal(
    packageJson.scripts['test:config:flux2'],
    'node --test scripts/integration-test-selection.test.mjs'
  )

  for (const file of [
    'generate-image-flux2-fusion.test.js',
    'generate-image-flux2-fusion-surjective.test.js',
    'generate-image-flux2-i2i.test.js'
  ]) {
    const source = fs.readFileSync(path.join(integrationDir, file), 'utf8')
    assert.doesNotMatch(source, /flux2-gate|getFlux2Skip|SKIP_FLUX2|RUNNER_ENVIRONMENT/)
  }
})
