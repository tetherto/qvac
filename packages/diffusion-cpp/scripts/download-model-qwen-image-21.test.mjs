import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const source = readFileSync(new URL('./download-model-qwen-image-21.sh', import.meta.url), 'utf8')
const model = 'qwen_image_2.1-Q4_K.gguf'
const fixture = 'verified model fixture\n'

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwen-download-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'bin'))
  mkdirSync(join(root, 'models'))
  writeFileSync(join(root, 'fixture'), fixture)
  // Keep the complete downloader flow, with tiny fixtures instead of model weights.
  const hash = createHash('sha256').update(fixture).digest('hex')
  writeFileSync(join(root, 'downloader.sh'), source.replace(/\b[a-f0-9]{64}\b/g, hash))
  writeFileSync(
    join(root, 'bin', 'curl'),
    `#!/usr/bin/env bash
set -eu
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then out="$2"; shift; fi
  shift
done
printf 'called\\n' >> "$PWD/curl-calls"
if [[ "$INTERRUPT_DOWNLOAD" == 1 ]]; then
  printf 'partial' > "$out"
  exit 18
fi
# Simulate curl resuming an existing partial, or starting a fresh download.
cat "$PWD/fixture" >> "$out"
`,
    { mode: 0o755 }
  )
  const run = (extraEnv = {}) => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        'export PATH="$PWD/bin:$PATH" QWEN_MODELS_DIR="$PWD/models"; exec bash ./downloader.sh'
      ],
      { cwd: root, env: { ...process.env, INTERRUPT_DOWNLOAD: '0', ...extraEnv }, encoding: 'utf8' }
    )
    assert.ifError(result.error)
    return result
  }
  return {
    root,
    run,
    partial: join(root, 'models', model + '.part'),
    final: join(root, 'models', model)
  }
}

test('Qwen downloader discards a corrupt partial and recovers on the next run', (t) => {
  const { root, run, partial, final } = sandbox(t)
  writeFileSync(partial, 'corrupt or stale revision')
  const failed = run()
  assert.notEqual(failed.status, 0)
  assert.equal(existsSync(partial), false)
  assert.equal(existsSync(final), false)
  const recovered = run()
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.equal(readFileSync(final, 'utf8'), fixture)
  const calls = readFileSync(join(root, 'curl-calls'), 'utf8')
  assert.equal(run().status, 0)
  assert.equal(readFileSync(join(root, 'curl-calls'), 'utf8'), calls, 'verified files are reused')
})

test('Qwen downloader preserves partial downloads after a transport interruption', (t) => {
  const { run, partial, final } = sandbox(t)
  assert.equal(run({ INTERRUPT_DOWNLOAD: '1' }).status, 18)
  assert.equal(readFileSync(partial, 'utf8'), 'partial')
  assert.equal(existsSync(final), false)
})
