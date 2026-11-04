import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(join(root, '.github/workflows/on-pr-nx.yml'), 'utf8')
const action = readFileSync(join(root, '.github/actions/nx-project-matrix/action.yml'), 'utf8')
const script = action.split('    - id: compute\n')[1].split('      run: |\n')[1]
  .split('\n').map(line => line.slice(8)).join('\n')

function runMatrix(packages, { target = 'on-pr', configRef = 'HEAD', baseRef = 'HEAD', cwd = root } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qvac-dispatch-matrix-'))
  const output = join(directory, 'output')
  try {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        INPUT_TARGET: target,
        INPUT_BASE_REF: baseRef,
        INPUT_HEAD_REF: 'HEAD',
        INPUT_CONFIG_REF: configRef,
        INPUT_OVERRIDES: '{}',
        INPUT_PACKAGES: packages,
        GITHUB_OUTPUT: output,
      },
    })
    return { ...result, output: result.status === 0 ? readFileSync(output, 'utf8') : '' }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('the on-pr orchestrator accepts explicit packages only on manual dispatch', () => {
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      packages:\n[\s\S]*?default: '\[\]'/)
  assert.match(workflow, /target: on-pr\n[^\n]*config-ref:[^\n]*\n\s+packages: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.packages \|\| '\[\]' \}\}/)
})

test('explicit ASR selection builds a nonempty on-pr matrix even with no affected code', () => {
  const result = runMatrix('["asr-ggml"]')
  assert.equal(result.status, 0, result.stderr)
  const matrix = JSON.parse(result.output.match(/^matrix=(.+)$/m)[1])
  assert.ok(matrix.length > 0)
  assert.deepEqual([...new Set(matrix.map(row => row.package))], ['asr-ggml'])
  assert.ok(matrix.every(row => row.hasPrebuilds && row.hasCppTests))
  assert.match(result.output, /^any=true$/m)
})

test('explicit package selection rejects a non-array input', () => {
  const result = runMatrix('{"package":"asr-ggml"}')
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /packages must be a JSON array/)
})


function jobBlock(source, name) {
  const start = source.indexOf(`\n  ${name}:`)
  assert.notEqual(start, -1, `job ${name} exists`)
  const rest = source.slice(start + 1)
  const next = rest.search(/\n {2}[A-Za-z_][A-Za-z0-9_-]*:/)
  return next === -1 ? rest : rest.slice(0, next)
}

test('manual reviewed configuration reaches every nested matrix without changing PR trust', () => {
  const guarded = "${{ github.event_name == 'workflow_dispatch' && inputs.config_ref_override || '' }}"
  for (const [job, file] of [
    ['prebuild', 'prebuilds-nx.yml'],
    ['cpp-tests', 'cpp-tests-nx.yml'],
    ['run-integration-tests', 'integration-test-nx.yml'],
  ]) {
    assert.ok(jobBlock(workflow, job).includes(`config-ref: ${guarded}`))
    const leaf = readFileSync(join(root, '.github/workflows', file), 'utf8')
    assert.equal((leaf.match(/^      config-ref:$/gm) || []).length, 2, `${file} declares config-ref for dispatch and call`)
    assert.match(jobBlock(leaf, 'matrix'), /config-ref: \$\{\{ inputs\.config-ref \}\}/)
  }
  assert.ok(jobBlock(workflow, 'matrix').includes("config-ref: ${{ github.event_name == 'workflow_dispatch' && inputs.config_ref_override || github.event.repository.default_branch }}"))
})

function configRepository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'qvac-reviewed-config-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  function git(...args) {
    const result = spawnSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  const projectPath = join(cwd, 'packages/diffusion-cpp/project.json')
  mkdirSync(dirname(projectPath), { recursive: true })
  const project = { root: 'packages/diffusion-cpp', targets: { build: { options: { ci: { includeVulkanSdk: true } } } } }
  writeFileSync(projectPath, JSON.stringify(project))
  git('add', '.')
  git('commit', '-qm', 'base config without CUDA toolkit')
  const baseRef = git('rev-parse', 'HEAD')
  Object.assign(project.targets.build.options.ci, { includeCuda: true, includeCudaArm64: true })
  writeFileSync(projectPath, JSON.stringify(project))
  git('add', '.')
  git('commit', '-qm', 'reviewed CUDA toolkit config')
  return { cwd, baseRef, configRef: git('rev-parse', 'HEAD'), target: 'build' }
}

test('reviewed build config enables CUDA independently of the affected base', (t) => {
  const result = runMatrix('["diffusion-cpp"]', configRepository(t))
  assert.equal(result.status, 0, result.stderr)
  const matrix = JSON.parse(result.output.match(/^matrix=(.+)$/m)[1])
  assert.equal(matrix.length, 1)
  assert.equal(matrix[0].includeCuda, true)
  assert.equal(matrix[0].includeCudaArm64, true)
})

test('empty config-ref retains the affected base configuration', (t) => {
  const result = runMatrix('["diffusion-cpp"]', { ...configRepository(t), configRef: '' })
  assert.equal(result.status, 0, result.stderr)
  const matrix = JSON.parse(result.output.match(/^matrix=(.+)$/m)[1])
  assert.equal(matrix[0].includeVulkanSdk, true)
  assert.notEqual(matrix[0].includeCuda, true)
})

test('failed prebuilds cannot start artifact consumers or empty performance collectors', () => {
  assert.match(jobBlock(workflow, 'run-integration-tests'), /needs\.prebuild\.result == 'success'/)
  for (const job of ['perf-report', 'perf-report-rtf']) {
    const block = jobBlock(workflow, job)
    assert.ok(block.includes("needs.run-integration-tests.result == 'success' || needs.run-integration-tests.result == 'failure'"))
  }
})

test('fabric stacks and reviewed manual configs bypass cross-run prebuild reuse', () => {
  const block = jobBlock(workflow, 'prebuild')
  assert.ok(block.includes("reuse-workflow-file: ${{ needs.detect-fabric-stack.outputs.fabric_stack != 'true' && !(github.event_name == 'workflow_dispatch' && inputs.config_ref_override != '') && 'on-pr-nx.yml' || '' }}"))
})


test('generic performance uploads match the on-pr collector and separate Linux runners', () => {
  const leaf = readFileSync(join(root, '.github/workflows/integration-test-nx.yml'), 'utf8')
  const step = leaf.split('      - name: Upload performance report\n')[1].split('      # RTF benchmark leg:')[0]
  const template = step.match(/^          name: (.+)$/m)[1]
  const project = JSON.parse(readFileSync(join(root, 'packages/diffusion-cpp/project.json'), 'utf8'))
  const pattern = project.targets['on-pr'].options.ci.perfReportPattern + '-42'
  const regex = new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  const names = ['ubuntu-22.04', 'ubuntu-24.04'].map(os => template
    .replaceAll('${{ matrix.package }}', 'diffusion-cpp')
    .replaceAll('${{ matrix.os || matrix.platform }}', os)
    .replaceAll('${{ matrix.arch }}', 'x64')
    .replaceAll('${{ github.run_number }}', '42'))
  for (const name of names) assert.match(name, regex)
  assert.notEqual(names[0], names[1], 'Ubuntu 22 and 24 reports must not collide')
})


test('combined report keeps the full host name for two-part addon slugs', (t) => {
  const source = readFileSync(join(root, '.github/actions/run-mobile-integration-tests/combine-perf-reports/action.yml'), 'utf8')
  const step = source.split('    - name: Fix desktop device names\n')[1].split('    - name: Generate combined report')[0]
  const run = step.split('      run: |\n')[1].split('\n').map(line => line.slice(8)).join('\n')
  const cwd = mkdtempSync(join(tmpdir(), 'qvac-report-host-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const directory = join(cwd, 'combined-reports/perf-report-diffusion-cpp-ubuntu-22.04-x64-42')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'performance-report.json')
  writeFileSync(file, JSON.stringify({ device: {} }))
  const result = spawnSync('bash', ['-e', '-c', run], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ARTIFACT_PATTERN: 'perf-report-diffusion-cpp-*-42', RUN_NUMBER: '42' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).device.name, 'ubuntu-22.04-x64')
})
