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
const modelFamilyFiles = {
  flux2: testFiles.filter((file) => /flux2/i.test(path.basename(file))),
  ideogram: testFiles.filter((file) => /ideogram/i.test(path.basename(file)))
}
const unsupportedFamilyFiles = [...modelFamilyFiles.flux2, ...modelFamilyFiles.ideogram]
const unrelatedFiles = testFiles.filter((file) => !unsupportedFamilyFiles.includes(file))
const workflow = fs.readFileSync(
  path.join(repoDir, '.github/workflows/integration-test-diffusion-cpp.yml'),
  'utf8'
)
const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))

function select({ env = {}, platform = 'linux', arch = 'x64' } = {}) {
  return selectIntegrationTests(testFiles, { env, platform, arch })
}

function assertAllTestsSelected(selection) {
  assert.deepEqual(selection.families, [])
  assert.deepEqual(selection.selected, testFiles)
  assert.deepEqual(selection.skipped, [])
  assert.equal(selection.reason, null)
}

function assertUnsupportedFamiliesSkipped(selection) {
  assert.deepEqual(selection.families, ['flux2', 'ideogram'])
  assert.deepEqual(selection.skipped, unsupportedFamilyFiles)
  assert.deepEqual(selection.selected, unrelatedFiles)
}

test('default selection includes every model family', () => {
  assert.ok(modelFamilyFiles.flux2.length >= 5, 'expected all current FLUX2 tests in the fixture')
  assert.ok(
    modelFamilyFiles.ideogram.length >= 1,
    'expected all current Ideogram tests in the fixture'
  )
  assert.ok(unrelatedFiles.length > 0, 'expected unrelated tests in the fixture')
  assertAllTestsSelected(select())
})

test('explicit family list excludes every named family and no unrelated test', () => {
  const selection = select({ env: { SKIP_DIFFUSION_MODELS: 'flux2,ideogram' } })

  assert.equal(selection.reason, 'SKIP_DIFFUSION_MODELS=flux2,ideogram')
  assertUnsupportedFamiliesSkipped(selection)
})

test('GitHub-hosted Darwin arm64 fallback excludes unsupported model families', () => {
  const selection = select({
    env: {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted'
    },
    platform: 'darwin',
    arch: 'arm64'
  })

  assert.equal(selection.reason, 'GitHub-hosted Darwin arm64 runner')
  assertUnsupportedFamiliesSkipped(selection)
})

test('self-hosted Darwin arm64 retains every model family', () => {
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

test('other operating systems and architectures retain every model family', () => {
  const githubHosted = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted'
  }

  assertAllTestsSelected(select({ env: githubHosted, platform: 'darwin', arch: 'x64' }))
  assertAllTestsSelected(select({ env: githubHosted, platform: 'linux', arch: 'arm64' }))
  assertAllTestsSelected(select({ env: githubHosted, platform: 'win32', arch: 'x64' }))
})

test('workflow scopes model-family exclusions to the macos-26-xlarge matrix leg', () => {
  const oldFamilyGate = ['SKIP', 'FLUX2'].join('_')
  const oldFusionGate = [oldFamilyGate, 'FUSION'].join('_')
  const targetMatrixEntry = [
    '          - os: mac-mini-m4',
    '            platform: darwin',
    '            arch: arm64',
    '            runner: macos-26-xlarge',
    "            ltx: 'true'",
    '            skip_diffusion_models: flux2,ideogram'
  ].join('\n')

  assert.ok(workflow.includes(targetMatrixEntry))
  assert.equal((workflow.match(/skip_diffusion_models: flux2,ideogram/g) || []).length, 1)
  assert.match(workflow, /SKIP_DIFFUSION_MODELS: \$\{\{ matrix\.skip_diffusion_models \|\| '' \}\}/)
  assert.equal(workflow.includes(oldFamilyGate), false)
  assert.equal(workflow.includes(oldFamilyGate.toLowerCase()), false)
  assert.equal(workflow.includes(oldFusionGate), false)
  assert.equal(workflow.includes(oldFusionGate.toLowerCase()), false)
})

test('package scripts use the unified selector and old per-test gates are gone', () => {
  assert.equal(
    packageJson.scripts['test:integration:generate'],
    'node scripts/generate-integration-tests.mjs && npm run test:mobile:generate'
  )
  assert.equal(
    packageJson.scripts['test:config:integration-selection'],
    'node --test scripts/integration-test-selection.test.mjs'
  )

  for (const testFile of unsupportedFamilyFiles) {
    const source = fs.readFileSync(path.join(packageDir, testFile), 'utf8')
    assert.doesNotMatch(
      source,
      /flux2-gate|getFlux2Skip|SKIP_DIFFUSION_MODELS|GITHUB_ACTIONS|RUNNER_ENVIRONMENT/
    )
  }
})
