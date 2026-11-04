import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(new URL('./download-model-flux3.sh', import.meta.url), 'utf8')
const payload = 'verified model fixture\n'
const hash = createHash('sha256').update(payload).digest('hex')
const files = [
  'flux3-vae.safetensors',
  'flux3-image-klein-Q8_0.gguf',
  'Qwen3VL-4B-Instruct-Q4_K_M.gguf'
]

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flux3-download-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = join(dir, 'models with spaces')
  const bin = join(dir, 'bin')
  mkdirSync(out)
  mkdirSync(bin)
  const script = join(dir, 'download.sh')
  // Substitute only the artifact digests, retaining the actual downloader logic.
  writeFileSync(script, source.replace(/\b[a-f0-9]{64}\b/g, hash))
  const log = join(dir, 'calls')
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.CURL_LOG, JSON.stringify(args) + '\\n')
const file = args[args.indexOf('-o') + 1]
if (process.env.FAIL_DOWNLOAD) {
  fs.writeFileSync(file, 'partial')
  process.exit(22)
}
fs.writeFileSync(file, process.env.BAD_HASH ? 'bad bytes' : ${JSON.stringify(payload)})
`,
    { mode: 0o755 }
  )
  const run = (env = {}) =>
    spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FLUX3_MODELS_DIR: out,
        CURL_LOG: log,
        HF_TOKEN: 'test-token',
        BAD_HASH: '',
        FAIL_DOWNLOAD: '',
        ...env
      }
    })
  const calls = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
  return { out, run, calls }
}

test('downloads pinned files, authenticates only the VAE, and reuses verified cache', (t) => {
  const { out, run, calls } = fixture(t)
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  assert.equal(calls().length, 3)
  for (const args of calls()) {
    assert.ok(args.includes('--fail'))
    assert.equal(args[args.indexOf('--continue-at') + 1], '-')
    assert.ok(args.some((arg) => /\/resolve\/[a-f0-9]{40}\//.test(arg)))
  }
  assert.ok(calls()[0].includes('Authorization: Bearer test-token'))
  assert.ok(
    calls()
      .slice(1)
      .every((args) => !args.includes('--header'))
  )
  for (const file of files) {
    assert.equal(readFileSync(join(out, file), 'utf8'), payload)
    assert.equal(existsSync(join(out, `${file}.part`)), false)
  }
  assert.equal(run({ HF_TOKEN: '' }).status, 0)
  assert.equal(calls().length, 3)
})

test('missing VAE token fails before downloading public weights', (t) => {
  const { run, calls } = fixture(t)
  const result = run({ HF_TOKEN: '' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /HF_TOKEN is required/)
  assert.equal(calls().length, 0)
})

test('checksum failure never promotes partial bytes and permits a clean retry', (t) => {
  const { out, run } = fixture(t)
  assert.notEqual(run({ BAD_HASH: '1' }).status, 0)
  assert.equal(existsSync(join(out, files[0])), false)
  assert.equal(existsSync(join(out, `${files[0]}.part`)), false)
  assert.equal(run().status, 0)
})

test('network failure retains partial transfer for resuming', (t) => {
  const { out, run, calls } = fixture(t)
  assert.notEqual(run({ FAIL_DOWNLOAD: '1' }).status, 0)
  assert.equal(existsSync(join(out, files[0])), false)
  assert.equal(readFileSync(join(out, `${files[0]}.part`), 'utf8'), 'partial')
  assert.equal(run().status, 0)
  assert.equal(calls()[1][calls()[1].indexOf('--continue-at') + 1], '-')
})

test('corrupted cached file is replaced only after a verified download', (t) => {
  const { out, run } = fixture(t)
  writeFileSync(join(out, files[0]), 'corrupted cache')
  assert.notEqual(run({ BAD_HASH: '1' }).status, 0)
  assert.equal(readFileSync(join(out, files[0]), 'utf8'), 'corrupted cache')
  assert.equal(run().status, 0)
  assert.equal(readFileSync(join(out, files[0]), 'utf8'), payload)
})

test('downloader has valid Bash syntax', () => {
  execFileSync('bash', ['-n'], { input: source })
})
