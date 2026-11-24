import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const bash = process.env.BASH_BIN || 'bash'
const source = readFileSync(
  new URL('./download-model-fibo2-edit-turbo.sh', import.meta.url),
  'utf8'
)
const payload = 'verified Fibo model fixture\n'
const hash = createHash('sha256').update(payload).digest('hex')
const files = [
  'fibo2_edit_turbo-q4_0.gguf',
  'Qwen3VL-4B-Instruct-Q4_K_M.gguf',
  'mmproj-Qwen3VL-4B-Instruct-F16.gguf',
  'vae/flux2-vae.safetensors'
]

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fibo-download-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const out = join(root, 'models with spaces')
  const bin = join(root, 'bin')
  mkdirSync(out)
  mkdirSync(bin)
  const script = join(root, 'download.sh')
  // Change only artifact hashes/sizes; exercise the production downloader flow.
  writeFileSync(
    script,
    source.replace(/\b[a-f0-9]{64} \d+\b/g, `${hash} ${Buffer.byteLength(payload)}`)
  )
  const log = join(root, 'curl-calls')
  writeFileSync(
    join(bin, 'curl'),
    `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.CURL_LOG, JSON.stringify(args) + '\\n')
const file = args[args.indexOf('-o') + 1]
const payload = ${JSON.stringify(payload)}
const prefix = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
if (prefix && args[args.indexOf('--continue-at') + 1] !== '-') process.exit(33)
if (process.env.FAIL_DOWNLOAD) {
  fs.writeFileSync(file, payload.slice(0, 7))
  process.exit(18)
}
// Simulate byte-range resume, including a corrupt prefix.
fs.appendFileSync(file, process.env.BAD_HASH ? 'x'.repeat(payload.length - prefix.length) : payload.slice(prefix.length))
`,
    { mode: 0o755 }
  )
  const run = (args = [], env = {}) => {
    const result = spawnSync(bash, [script, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIBO_MODELS_DIR: out,
        CURL_LOG: log,
        HF_TOKEN: '',
        BAD_HASH: '',
        FAIL_DOWNLOAD: '',
        ...env
      }
    })
    assert.ifError(result.error)
    return result
  }
  const calls = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
  return { root, out, run, calls, lock: join(out, '.download-fibo2-edit-turbo.lock') }
}

test('downloads all four public pinned files and verifies existing files on rerun', (t) => {
  const { out, run, calls, lock } = fixture(t)
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  assert.equal(calls().length, 4)
  for (const args of calls()) {
    assert.equal(args[0], '--disable')
    assert.ok(args.includes('--fail'))
    assert.equal(args[args.indexOf('--continue-at') + 1], '-')
    assert.ok(args.some((arg) => /https:\/\/huggingface.co\/.+\/resolve\/[a-f0-9]{40}\//.test(arg)))
    assert.ok(!args.includes('--header'))
  }
  for (const file of files) {
    assert.equal(readFileSync(join(out, file), 'utf8'), payload)
    assert.equal(existsSync(join(out, `${file}.part`)), false)
  }
  assert.equal(existsSync(lock), false)
  assert.equal(run().status, 0)
  assert.equal(calls().length, 4, 'verified files must not be downloaded again')
})

test('dry-run and help do not create output directories or access the network', (t) => {
  const { root, run, calls } = fixture(t)
  const out = join(root, 'not created')
  const dry = run(['--dry-run'], { FIBO_MODELS_DIR: out })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /8540063644 bytes/)
  for (const file of files) assert.ok(dry.stdout.includes(file))
  assert.equal(run(['--help'], { FIBO_MODELS_DIR: out }).status, 0)
  assert.equal(existsSync(out), false)
  assert.equal(calls().length, 0)
  assert.equal(run(['--unknown']).status, 2)
})

test('interrupted downloads keep partial bytes and release the lock for resume', (t) => {
  const { out, run, lock } = fixture(t)
  assert.equal(run([], { FAIL_DOWNLOAD: '1' }).status, 18)
  assert.equal(existsSync(join(out, files[0])), false)
  assert.equal(readFileSync(join(out, `${files[0]}.part`), 'utf8'), payload.slice(0, 7))
  assert.equal(existsSync(lock), false)
  assert.equal(run().status, 0)
  assert.equal(readFileSync(join(out, files[0]), 'utf8'), payload)
})

test('completed valid partial is promoted without redownloading it', (t) => {
  const { out, run, calls } = fixture(t)
  writeFileSync(join(out, `${files[0]}.part`), payload)
  assert.equal(run().status, 0)
  assert.equal(calls().length, 3)
  assert.equal(readFileSync(join(out, files[0]), 'utf8'), payload)
})

test('bad hashes never replace an existing file and allow a clean retry', (t) => {
  const { out, run, lock } = fixture(t)
  const target = join(out, files[0])
  writeFileSync(target, 'corrupt existing model')
  assert.notEqual(run([], { BAD_HASH: '1' }).status, 0)
  assert.equal(readFileSync(target, 'utf8'), 'corrupt existing model')
  assert.equal(existsSync(`${target}.part`), false)
  assert.equal(existsSync(lock), false)
  assert.equal(run().status, 0)
  assert.equal(readFileSync(target, 'utf8'), payload)
})

test('corrupt resume prefix fails checksum and is discarded', (t) => {
  const { out, run } = fixture(t)
  const target = join(out, files[0])
  writeFileSync(`${target}.part`, 'bad')
  assert.notEqual(run().status, 0)
  assert.equal(existsSync(target), false)
  assert.equal(existsSync(`${target}.part`), false)
  assert.equal(run().status, 0)
})

test('oversized partial is replaced with a fresh download', (t) => {
  const { out, run } = fixture(t)
  writeFileSync(join(out, `${files[0]}.part`), payload + 'extra bytes')
  assert.equal(run().status, 0)
  assert.equal(readFileSync(join(out, files[0]), 'utf8'), payload)
})

test('another downloader lock prevents writes and remains owned by that downloader', (t) => {
  const { run, calls, lock } = fixture(t)
  mkdirSync(lock)
  const result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Cannot lock/)
  assert.equal(calls().length, 0)
  assert.equal(existsSync(lock), true)
})

test('an unwritable destination fails before a network request', (t) => {
  const { root, run, calls } = fixture(t)
  const file = join(root, 'ordinary file')
  writeFileSync(file, 'not a directory')
  assert.notEqual(run([], { FIBO_MODELS_DIR: join(file, 'models') }).status, 0)
  assert.equal(calls().length, 0)
})

test('downloader has valid Bash syntax', () => {
  execFileSync(bash, ['-n'], { input: source })
})
