import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'streamx'
import { tree } from '../../dist/cli/index.js'
import { runHelp } from '../../dist/cli/commands/help/help.js'
import { versionText } from '../../dist/cli/version.js'
import { downloadMeter, progressLine } from '../../dist/cli/progress.js'
import { bytes, duration } from '../../dist/cli/format.js'
import { logFiles, tailLines, printLogs, followLogs } from '../../dist/cli/commands/logs/logs.js'
import { Prompter } from '../../dist/cli/prompt.js'
import { configText } from '../../dist/cli/commands/config/config.js'

const root = path.resolve(import.meta.dirname, '../..')

test("help lists every command, from each command's own definition", () => {
  const text = tree({ version: '1.2.3' }).help()
  assert.match(text, /^QV\.AC 1\.2\.3/)
  for (const name of [
    'serve',
    'invite',
    'workspace',
    'models',
    'status',
    'logs',
    'config',
    'chat',
    'help',
    'sdk'
  ]) {
    assert.match(text, new RegExp(`\\n\\s+${name}\\s`), name)
  }

  assert.match(text, /QVAC_<FLAG_NAME>/)
})

test('help for one command, nested ones included, and none for what is not a command', () => {
  const printed = []
  const log = console.log
  console.log = (text) => printed.push(text)
  try {
    runHelp({ words: ['workspace', 'join'] }, { version: 'x', usage: () => {} })
    runHelp({ words: ['logs'] }, { version: 'x', usage: () => {} })
  } finally {
    console.log = log
  }

  assert.match(printed[0], /qvac workspace join \[flags\] <link>/)
  assert.match(printed[1], /--tail <value>/)
  assert.throws(
    () =>
      runHelp(
        { words: ['nope'] },
        {
          version: 'x',
          usage: (message) => {
            throw new Error(message)
          }
        }
      ),
    /no help for nope/
  )
})

test('config prints each merged value with its source', () => {
  const loaded = {
    config: { core: { model: 'quack', dataDir: '/srv/qvac' }, tui: { theme: 'qvac' } },
    sources: { 'core.model': 'qvac.config.json', 'tui.theme': 'default' },
    configPath: '/work/qvac.config.json'
  }
  const text = configText(loaded, { json: false })
  assert.match(text, /^QV\.AC configuration, from \/work\/qvac\.config\.json/)
  assert.match(text, /\ncore\.model = "quack" · qvac\.config\.json/)
  assert.match(text, /\ntui\.theme = "qvac" · default/)
  assert.deepEqual(JSON.parse(configText(loaded, { json: true })), loaded)
})

test('version names the CLI and the installed Core and harness', () => {
  const text = versionText(root)
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version
  const line = (name, version) => new RegExp(`${name} +${version.replaceAll('.', '\\.')}(\n|$)`)
  assert.match(text, new RegExp(`^@qvac/cli ${read('package.json').replaceAll('.', '\\.')}`))
  assert.match(text, line('core', read('node_modules/@qvac/core/package.json')))
  assert.match(text, line('harness', read('node_modules/@qvac/harness/package.json')))
})

test('download speed and ETA come from the deltas between frames', () => {
  const measure = downloadMeter()
  const frame = (downloaded, updatedAt) => ({
    name: 'm',
    phase: 'downloading',
    downloaded,
    total: 1000_000,
    updatedAt
  })

  const first = measure(frame(0, 1000))
  assert.equal(first.speed, 0)
  assert.equal(first.eta, null)

  const second = measure(frame(100_000, 2000))
  assert.equal(second.speed, 100_000)
  assert.equal(second.percent, 10)
  assert.equal(second.eta, 9)
  assert.equal(progressLine(second), 'm   10%  ·  100 KB of 1.0 MB  ·  100 KB/s  ·  9s left')

  const third = measure(frame(400_000, 3000))
  assert.equal(third.speed, 100_000 + 0.3 * (300_000 - 100_000))
})

test('a frame that is not downloading says its phase', () => {
  assert.equal(
    progressLine(downloadMeter()({ name: 'm', phase: 'queued', updatedAt: 1 })),
    'm  queued'
  )
})

test('sizes and durations read like a person wrote them', () => {
  assert.equal(bytes(0), '0 B')
  assert.equal(bytes(84_700_000), '84.7 MB')
  assert.equal(bytes(17_612_564_704), '17.6 GB')
  assert.equal(duration(42), '42s')
  assert.equal(duration(125), '2m 05s')
  assert.equal(duration(7260), '2h 01m')
})

test('logs print the tail of each log, then what is appended after it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-logs-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const assistant = path.join(dir, 'assistant.log')
  fs.writeFileSync(assistant, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n')
  assert.deepEqual(logFiles(dir), [assistant])
  assert.deepEqual(tailLines(assistant, 2).lines, ['line 98', 'line 99'])

  const { out, written } = sink()
  const offsets = printLogs([assistant], { tail: 3, out })
  assert.equal(written(), 'line 97\nline 98\nline 99\n')

  const appended = new Promise((resolve) => (out.onWrite = resolve))
  fs.appendFileSync(assistant, 'new line\n')
  const stop = new AbortController()
  const following = followLogs(offsets, { out, signal: stop.signal })
  await appended
  stop.abort()
  await following
  assert.ok(written().endsWith('line 99\nnew line\n'))
})

test('the tail of a log larger than one read block is whole lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-logs-'))
  const file = path.join(dir, 'assistant.log')
  const lines = Array.from({ length: 5000 }, (_, i) => `entry ${i} ${'é'.repeat(20)}`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  assert.deepEqual(tailLines(file, 3000).lines, lines.slice(-3000))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('questions read one line each, with a default for an empty answer', async () => {
  const input = new PassThrough()
  const { out, written } = sink()
  const prompter = new Prompter(input, out)

  input.write('join\nqvac://work')
  assert.equal(await prompter.ask('Join or create'), 'join')
  const link = prompter.ask('Paste the invite link')
  input.write('space/abc\n\n')
  assert.equal(await link, 'qvac://workspace/abc')
  assert.equal(await prompter.ask('Your name', { fallback: 'ada' }), 'ada')
  prompter.close()

  assert.equal(written(), 'Join or create: Paste the invite link: Your name [ada]: ')
})

test('a question with nothing left to read fails instead of hanging', async () => {
  const input = new PassThrough()
  const prompter = new Prompter(input, sink().out)
  const answer = prompter.ask('Your name')
  input.end()
  await assert.rejects(answer, /input closed/)
})

function sink() {
  const chunks = []
  const out = {
    onWrite: null,
    write(chunk) {
      chunks.push(String(chunk))
      out.onWrite?.()
    }
  }

  return { out, written: () => chunks.join('') }
}
