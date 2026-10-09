import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(join(root, '.github/workflows/on-pr-nx.yml'), 'utf8')
const action = readFileSync(join(root, '.github/actions/nx-project-matrix/action.yml'), 'utf8')
const script = action.split('    - id: compute\n')[1].split('      run: |\n')[1]
  .split('\n').map(line => line.slice(8)).join('\n')

function runMatrix(packages) {
  const directory = mkdtempSync(join(tmpdir(), 'qvac-dispatch-matrix-'))
  const output = join(directory, 'output')
  try {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        INPUT_TARGET: 'on-pr',
        INPUT_BASE_REF: 'HEAD',
        INPUT_HEAD_REF: 'HEAD',
        INPUT_CONFIG_REF: 'HEAD',
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
