import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
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

test('explicit package selection rejects a non-array input', () => {
  const result = runMatrix('{"package":"asr-ggml"}')
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /packages must be a JSON array/)
})
