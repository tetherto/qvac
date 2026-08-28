import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  ACTIONLINT_YAML,
  REUSABLE_WORKFLOW,
  RUNNERS_YAML,
  assertReusableMatchesCatalog,
  findHardcodedLabelViolations,
  findJobsMissingNeeds,
  findMissingActionlintLabels,
  findMissingRunnerNamesNeeds,
  findRunnerNamesMissingPermissions,
  listAddonWorkflows,
  loadRunners,
  parseRunnersYaml,
  readRepoFile,
  renderReusableWorkflow,
  repoRoot,
} from '../lib/runner-names.mjs'

test('runners.yaml parses with unique keys and labels', () => {
  const runners = loadRunners()
  assert.ok(runners.length >= 10)
  assert.ok(runners.every((entry) => entry.key && entry.label))
  assert.equal(
    new Set(runners.map((entry) => entry.key)).size,
    runners.length,
  )
  assert.equal(
    new Set(runners.map((entry) => entry.label)).size,
    runners.length,
  )
  assert.ok(runners.some((entry) => entry.label.startsWith('qvac-')))
  assert.ok(runners.some((entry) => entry.key === 'macos_ios'))
  assert.equal(
    runners.find((entry) => entry.key === 'macos_ios').label,
    'macos-14',
  )
})

test('parseRunnersYaml rejects duplicates and junk', () => {
  assert.throws(
    () => parseRunnersYaml('macos_ios: macos-14\nmacos_ios: macos-15\n'),
    /duplicate runner key/,
  )
  assert.throws(
    () => parseRunnersYaml('macos_ios: macos-14\nother: macos-14\n'),
    /duplicate runner label/,
  )
  assert.throws(() => parseRunnersYaml('not yaml at all\n'), /invalid/)
  // The line parser must fail loudly on non-flat YAML rather than mis-parse it.
  assert.throws(() => parseRunnersYaml('macos_ios: "macos-14"\n'), /bare label/)
  assert.throws(() => parseRunnersYaml("macos_ios: 'macos-14'\n"), /bare label/)
  assert.throws(() => parseRunnersYaml('group:\n  macos_ios: macos-14\n'), /invalid/)
})

test('reusable-runner-names.yml matches the catalog', () => {
  const runners = loadRunners()
  assert.doesNotThrow(() => {
    assertReusableMatchesCatalog(runners, readRepoFile(REUSABLE_WORKFLOW))
  })
  const rendered = renderReusableWorkflow(runners)
  assert.match(rendered, /AUTO-GENERATED/)
  assert.match(rendered, /runs-on: ubuntu-latest/)
  assert.doesNotMatch(rendered, /actions\/checkout/)
  assert.match(rendered, /macos_ios=macos-14/)
})

test('actionlint.yaml lists every self-hosted catalog label', () => {
  const missing = findMissingActionlintLabels(
    loadRunners(),
    readRepoFile(ACTIONLINT_YAML),
  )
  assert.deepEqual(missing, [])
})

test('addon workflows do not hardcode catalog runner labels', () => {
  const runners = loadRunners()
  const findings = []
  for (const file of listAddonWorkflows()) {
    const source = readRepoFile(file)
    findings.push(...findHardcodedLabelViolations(file, source, runners))
    findings.push(...findMissingRunnerNamesNeeds(file, source))
    findings.push(...findJobsMissingNeeds(file, source))
  }
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 2))
})

test('every runner_names job declares an explicit permissions block', () => {
  const findings = []
  for (const file of listAddonWorkflows()) {
    findings.push(...findRunnerNamesMissingPermissions(file, readRepoFile(file)))
  }
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 2))
})

test('runner_names permissions detector flags a bare bootstrap job', () => {
  const withPerms = [
    'jobs:',
    '  runner_names:',
    '    permissions:',
    '      contents: read',
    '    uses: ./.github/workflows/reusable-runner-names.yml',
    '',
  ].join('\n')
  const bare = [
    'jobs:',
    '  runner_names:',
    '    uses: ./.github/workflows/reusable-runner-names.yml',
    '',
  ].join('\n')
  assert.deepEqual(findRunnerNamesMissingPermissions('ok.yml', withPerms), [])
  assert.equal(findRunnerNamesMissingPermissions('bad.yml', bare).length, 1)
})

test('hardcoded-label detector catches runner and runs-on literals', () => {
  const runners = parseRunnersYaml('macos_ios: macos-14\n')
  const source = [
    'jobs:',
    '  build:',
    '    runs-on: macos-14',
    '    steps:',
    '      - run: echo hi',
    '  pin:',
    "    runs-on: ${{ 'macos-14' }}",
    '  matrixy:',
    '    strategy:',
    '      matrix:',
    '        include:',
    '          - runner: macos-14',
    '  json:',
    '    strategy:',
    '      matrix:',
    '        include: \'[{"runner":"macos-14"}]\'',
    '  comment-only:',
    '    # runner: macos-14',
    '    runs-on: ubuntu-latest',
    '  identity:',
    '    os: macos-14',
    '',
  ].join('\n')

  const findings = findHardcodedLabelViolations('x.yml', source, runners)
  assert.equal(findings.length, 4)
  assert.deepEqual(
    findings.map((finding) => finding.line).sort((a, b) => a - b),
    [3, 7, 12, 16],
  )
})

test('hardcoded-label detector flags catalog labels inlined in a runs-on expression', () => {
  const runners = parseRunnersYaml('macos_ios: macos-14\nlinux_ubuntu2404_x64: qvac-ubuntu2404-x64\n')

  // Regression: labels inlined into the mobile ternary instead of via outputs.
  const inlined = [
    'jobs:',
    '  build:',
    "    runs-on: ${{ matrix.platform == 'iOS' && 'macos-14' || 'qvac-ubuntu2404-x64' }}",
    '',
  ].join('\n')
  const inlinedFindings = findHardcodedLabelViolations('bad.yml', inlined, runners)
  // The line is flagged (one finding per line); the label is a catalog label.
  assert.ok(inlinedFindings.length >= 1)
  assert.ok(inlinedFindings.every((f) => f.line === 3))
  assert.ok(
    inlinedFindings.every((f) => ['macos-14', 'qvac-ubuntu2404-x64'].includes(f.label)),
  )

  // Correct form (labels come from the catalog outputs) is not flagged.
  const viaOutputs = [
    'jobs:',
    '  build:',
    "    runs-on: ${{ matrix.platform == 'iOS' && needs.runner_names.outputs.macos_ios || needs.runner_names.outputs.linux_ubuntu2404_x64 }}",
    '',
  ].join('\n')
  assert.deepEqual(findHardcodedLabelViolations('ok.yml', viaOutputs, runners), [])

  // `os` identity conditionals are not runs-on/runner assignments -> not flagged.
  const osConditional = [
    'jobs:',
    '  build:',
    '    runs-on: ${{ needs.runner_names.outputs.macos_ios }}',
    '    steps:',
    "      - if: ${{ matrix.os == 'macos-14' }}",
    '        run: echo darwin',
    '',
  ].join('\n')
  assert.deepEqual(findHardcodedLabelViolations('ok2.yml', osConditional, runners), [])
})

test('validate-runner-names.mjs exits 0', () => {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, '.github/scripts/validate-runner-names.mjs')],
    { encoding: 'utf8', cwd: repoRoot },
  )
  assert.equal(
    result.status,
    0,
    `stdout=${result.stdout}\nstderr=${result.stderr}`,
  )
})

test('catalog path constants point at tracked files', () => {
  assert.equal(RUNNERS_YAML, '.github/runners.yaml')
  assert.match(readRepoFile(RUNNERS_YAML), /macos_ios:/)
})
