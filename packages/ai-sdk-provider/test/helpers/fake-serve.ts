import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isProcessAlive, readAllRecords, removeRecord } from '../../src/managed/registry.js'

// A stand-in for `qvac serve openai`: parses `--port`/`--host`, then behaves
// per FAKE_SERVE_BEHAVIOR. Lets the managed-mode tests drive every supervisor
// path (healthy, timeout, crash, SIGKILL escalation) without @qvac/cli or real
// models. Spawned verbatim through `serveBinPath`, so it relies on a POSIX
// shebang + exec bit — callers must skip on Windows.
const FAKE_SERVE = `#!/usr/bin/env node
const http = require('node:http')
const args = process.argv.slice(2)
function arg (name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const port = Number(arg('--port'))
const host = arg('--host') || '127.0.0.1'
const behavior = process.env.FAKE_SERVE_BEHAVIOR || 'healthy'

if (behavior === 'exit-immediately') { console.error('fake serve boom'); process.exit(3) }

// Stand-in for the real serve's \`bare\` inference worker: a stubborn grandchild
// that ignores SIGTERM and would survive a SIGKILL aimed at the serve pid alone.
// It is reaped only if stopServe signals the serve's whole process group. We
// write its pid to FAKE_WORKER_PIDFILE so the test can assert it died.
if (behavior === 'spawn-stubborn-worker') {
  const cp = require('node:child_process')
  const fs = require('node:fs')
  const worker = cp.spawn(process.execPath, ['-e', 'process.on(\\'SIGTERM\\', () => {}); setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
  if (process.env.FAKE_WORKER_PIDFILE) fs.writeFileSync(process.env.FAKE_WORKER_PIDFILE, String(worker.pid))
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.indexOf('/v1/models') === 0) {
    if (behavior === 'unhealthy') { res.statusCode = 503; res.end('not ready'); return }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [] }))
    return
  }
  res.statusCode = 404
  res.end()
})

if (behavior !== 'never-listen') server.listen(port, host)

if (behavior === 'ignore-sigterm' || behavior === 'spawn-stubborn-worker') {
  process.on('SIGTERM', () => {})
} else {
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 50) })
}
setInterval(() => {}, 1 << 30)
`

export const fakeServeSkip = process.platform === 'win32'

export async function makeFakeServe(): Promise<{ binPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-fakeserve-'))
  const binPath = join(dir, 'fake-serve.cjs')
  await writeFile(binPath, FAKE_SERVE, 'utf8')
  await chmod(binPath, 0o755)
  return { binPath, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// Redirect ~/.qvac so the supervisor's PID bookkeeping never touches real
// state. `os.homedir()` honours $HOME via libuv on POSIX.
export async function withFakeHome(fn: () => Promise<void>): Promise<void> {
  const prevHome = process.env['HOME']
  const fakeHome = await mkdtemp(join(tmpdir(), 'qvac-home-'))
  process.env['HOME'] = fakeHome
  try {
    await fn()
  } finally {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(fakeHome, { recursive: true, force: true })
  }
}

const BEHAVIOR_KEY = 'FAKE_SERVE_BEHAVIOR'
export function setBehavior(value: string | undefined): void {
  if (value === undefined) delete process.env[BEHAVIOR_KEY]
  else process.env[BEHAVIOR_KEY] = value
}

// Managed mode now spawns a *detached* runner that owns the serve and only
// reaps it on idle. Tests close their providers (which merely detaches), so we
// must kill the leftover runner + serve and drop their records ourselves to
// avoid leaking processes across the (isolated, fake-HOME) registry. Safe to
// call repeatedly; only touches serves recorded under the current $HOME.
export async function reapAllManaged(): Promise<void> {
  let records
  try {
    records = await readAllRecords()
  } catch {
    return
  }
  for (const rec of records) {
    for (const target of [rec.runnerPid, rec.servePid]) {
      if (isProcessAlive(target)) {
        try {
          process.kill(target, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
    removeRecord(rec.fleetKey)
  }
  // Give the OS a beat to reap the killed processes before the test asserts.
  await new Promise((r) => setTimeout(r, 100))
}
