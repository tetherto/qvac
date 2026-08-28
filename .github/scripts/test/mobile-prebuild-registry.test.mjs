// Guards the prebuild-resolution step of
// .github/actions/run-mobile-integration-tests/setup/action.yml.
//
// That step is the ONLY way an unmerged native change reaches a Device Farm
// device: a standalone workflow_dispatch builds no prebuild artifacts, so the
// dispatch `package` / `package_spec` input has to install a branch build from
// GitHub Packages. It used to run a bare `npm pack`, which always resolved
// registry.npmjs.org and therefore 404'd on every @tetherto/* spec while the
// inputs advertised exactly that form. These tests pin the routing so the
// capability cannot silently rot again.
//
// npm is mocked (fixtures/mobile-prebuilds/mock-npm), so nothing here needs a
// network or credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const ACTION = '.github/actions/run-mobile-integration-tests/setup/action.yml'
const STEP = 'Download prebuilds (from npm — fallback when no artifacts found)'
const GPR_HOST = 'https://npm.pkg.github.com'
const NPM_HOST = 'https://registry.npmjs.org'

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

// Pulls the literal shell out of a `run: |` block so the test exercises the
// same text CI executes. Mirrors the helper in ci-trust-policy.test.mjs.
function extractRunBlock(relativePath, stepName) {
  const source = read(relativePath)
  const stepIndex = source.indexOf(`name: ${stepName}`)
  assert.notEqual(stepIndex, -1, `step "${stepName}" exists in ${relativePath}`)

  const remainder = source.slice(stepIndex)
  const runMatch = remainder.match(/^(\s*)run:\s*\|\s*$/m)
  assert.ok(runMatch, `run block exists after "${stepName}" in ${relativePath}`)

  const runStart = stepIndex + runMatch.index + runMatch[0].length + 1
  const contentIndent = runMatch[1].length + 2
  const lines = source.slice(runStart).split('\n')
  const block = []

  for (const line of lines) {
    if (line === '') {
      block.push('')
      continue
    }
    if (line.startsWith(' '.repeat(contentIndent))) {
      block.push(line.slice(contentIndent))
      continue
    }
    break
  }

  return block.join('\n')
}

const script = extractRunBlock(ACTION, STEP)

assert.ok(
  !script.includes('${{'),
  'the step body must stay free of GitHub expressions so it is testable as plain shell',
)

// Runs the step in a throwaway dir standing in for addon/<addon-workdir>.
function runStep({
  packageVersion = '',
  addonName = '@qvac/llm-llamacpp',
  force = 'false',
  token = 'ghs-test-token',
  seedPrebuilds = false,
  npmEnv = {},
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qvac-mobile-prebuilds-'))
  const workdir = join(directory, 'addon')
  const runnerTemp = join(directory, 'runner-temp')
  const mockBin = join(directory, 'bin')
  const npmLog = join(directory, 'npm-invocations.log')

  mkdirSync(workdir, { recursive: true })
  mkdirSync(runnerTemp, { recursive: true })
  mkdirSync(mockBin, { recursive: true })
  writeFileSync(npmLog, '')

  const mockNpm = join(mockBin, 'npm')
  copyFileSync(
    join(root, '.github/scripts/test/fixtures/mobile-prebuilds/mock-npm'),
    mockNpm,
  )
  chmodSync(mockNpm, 0o755)

  if (seedPrebuilds) {
    mkdirSync(join(workdir, 'prebuilds/android-arm64'), { recursive: true })
    writeFileSync(join(workdir, 'prebuilds/android-arm64/marker.txt'), 'from-artifact')
  }

  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
    {
      cwd: workdir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${mockBin}:${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        ADDON_NPM_NAME: addonName,
        PACKAGE_VERSION: packageVersion,
        FORCE_NPM_PREBUILD: force,
        GPR_TOKEN: token,
        MOCK_NPM_LOG: npmLog,
        ...npmEnv,
      },
    },
  )

  const invocations = readFileSync(npmLog, 'utf8')
  const packDir = join(runnerTemp, 'gpr-prebuild-pack')

  const state = {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    invocations,
    packDirExists: existsSync(packDir),
    prebuildsExist: existsSync(join(workdir, 'prebuilds')),
    workdirNpmrcExists: existsSync(join(workdir, '.npmrc')),
    prebuildMarkerSurvived: existsSync(
      join(workdir, 'prebuilds/android-arm64/marker.txt'),
    ),
    androidPrebuildInstalled: existsSync(
      join(workdir, 'prebuilds/android-arm64/addon.bare'),
    ),
  }

  rmSync(directory, { recursive: true, force: true })
  return state
}

test('a @tetherto spec is resolved from GitHub Packages, with auth', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'true',
  })

  assert.equal(run.status, 0, run.output)
  assert.match(run.invocations, new RegExp(`registry=${GPR_HOST}`))
  assert.match(run.invocations, /auth=token/)
  assert.match(run.output, /GitHub Packages/)
  assert.ok(run.androidPrebuildInstalled, 'android prebuild landed in prebuilds/')
})

test('a @qvac spec still goes to npmjs.org and never to GitHub Packages', () => {
  const run = runStep({
    packageVersion: '@qvac/llm-llamacpp@0.46.0',
    force: 'true',
  })

  assert.equal(run.status, 0, run.output)
  assert.match(run.invocations, new RegExp(`registry=${NPM_HOST}`))
  assert.match(run.invocations, /npmrc_present=no/)
  assert.doesNotMatch(run.invocations, /npm\.pkg\.github\.com/)
})

test('an empty package-version still resolves <addon>@latest from npmjs.org', () => {
  const run = runStep({ addonName: '@qvac/llm-llamacpp' })

  assert.equal(run.status, 0, run.output)
  assert.match(run.invocations, /spec=@qvac\/llm-llamacpp@latest/)
  assert.match(run.invocations, new RegExp(`registry=${NPM_HOST}`))
})

test('a @tetherto spec without a token fails before contacting any registry', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'true',
    token: '',
  })

  assert.notEqual(run.status, 0)
  assert.match(run.output, /no token was supplied/)
  assert.match(run.output, /packages: read/)
  assert.equal(run.invocations, '', 'npm must not be invoked without a token')
})

test('a @tetherto spec missing the -mono suffix is called out', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp@0.47.0-tmp.runid-1',
    force: 'true',
  })

  // The suffix is a warning, not a hard failure: a handful of un-suffixed
  // packages still exist, they are just abandoned.
  assert.match(run.output, /::warning::/)
  assert.match(run.output, /-mono/)
})

test('a failed @tetherto resolve points at GitHub Packages, not npmjs.com', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.0.0-nope',
    force: 'true',
    npmEnv: { MOCK_NPM_FAIL_WITH: '404' },
  })

  assert.notEqual(run.status, 0)
  assert.match(run.output, /github\.com\/orgs\/tetherto\/packages/)
  assert.match(run.output, /tmp\.runid-/)
  assert.doesNotMatch(
    run.output,
    /www\.npmjs\.com/,
    'a GPR failure must not send the reader to npmjs.com',
  )
})

test('the token never lands in the addon checkout that gets bundled', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'true',
    token: 'ghs-secret-value',
  })

  assert.equal(run.status, 0, run.output)
  assert.equal(run.workdirNpmrcExists, false, 'no .npmrc left in the addon workdir')
  assert.equal(run.packDirExists, false, 'the pack dir (holding the .npmrc) is removed')
  assert.doesNotMatch(run.output, /ghs-secret-value/)
})

test('the pack dir is cleaned up even when the download fails', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.0.0-nope',
    force: 'true',
    npmEnv: { MOCK_NPM_FAIL_WITH: '404' },
  })

  assert.notEqual(run.status, 0)
  assert.equal(run.packDirExists, false)
})

test('artifact-first precedence is unchanged: artifacts win, npm is skipped', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'false',
    seedPrebuilds: true,
  })

  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /skipping npm fallback/)
  assert.equal(run.invocations, '', 'npm must not run when artifacts are present')
  assert.ok(run.prebuildMarkerSurvived, 'the artifact prebuild is left in place')
})

test('force-npm-prebuild discards artifacts so a pin cannot be shadowed', () => {
  // QVAC-21879: a benchmark baseline session once measured the candidate binary
  // because an artifact shadowed the pinned version.
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'true',
    seedPrebuilds: true,
  })

  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /discarding pre-existing prebuilds/)
  assert.equal(run.prebuildMarkerSurvived, false, 'the shadowing artifact is gone')
  assert.ok(run.androidPrebuildInstalled, 'the pinned package supplied the prebuild')
})

test('provenance mismatch fails instead of testing the wrong binary', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'true',
    npmEnv: { MOCK_NPM_VERSION: '0.1.0' },
  })

  assert.notEqual(run.status, 0)
  assert.match(run.output, /but package-version pins/)
})

test('a package without prebuilds/ is rejected', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'true',
    npmEnv: { MOCK_NPM_NO_PREBUILDS: '1' },
  })

  assert.notEqual(run.status, 0)
  assert.match(run.output, /No prebuilds directory found/)
})

// The dispatch inputs are what people copy from. They advertise the @tetherto
// form, so the advertised name must be the one publish-library-to-gpr actually
// publishes (`name-suffix: "-mono"`).
test('every mobile dispatch input advertises the -mono GPR name', () => {
  const workflows = spawnSync(
    'git',
    ['ls-files', '.github/workflows/integration-mobile-test-*.yml'],
    { cwd: root, encoding: 'utf8' },
  )
    .stdout.trim()
    .split('\n')
    .filter(Boolean)

  assert.ok(workflows.length >= 13, `found ${workflows.length} mobile workflows`)

  const offenders = []
  for (const relativePath of workflows) {
    // Any @tetherto/<name>@ spec whose name lacks the -mono suffix.
    for (const match of read(relativePath).matchAll(/@tetherto\/[a-z0-9-]+?(?<!-mono)@/g)) {
      offenders.push(`${relativePath}: ${match[0]}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `GPR dev builds are published as @tetherto/<addon>-mono:\n${offenders.join('\n')}`,
  )
})
