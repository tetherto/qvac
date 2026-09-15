'use strict'

// A model load that fails instead of crashing rejects outside the awaited
// chain. brittle records nothing, so the mobile runner used to return no
// summary at all — the harness read that as PASS and Device Farm went green
// with two of seven sub-tests never executed (run 34533640427). The runner must
// fail the runner it happened in, and exit non-zero.
//
// Runs in a child process on purpose: loading the runtime installs a beforeExit
// hook that exits(1) once a fatal error is recorded.

const test = require('brittle')
const path = require('bare-path')
const { spawn } = require('bare-subprocess')

const CHILD = path.join(__dirname, '_fixtures/fatal-runner-child.cjs')

function runChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(Bare.argv[0], [CHILD], { stdio: 'pipe' })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      out += d.toString()
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, out }))
  })
}

test('an out-of-band rejection fails the runner instead of reporting a pass', async function (t) {
  const { code, out } = await runChild()

  const line = out.split('\n').find((l) => l.startsWith('RESULT '))
  t.ok(line, `child printed a result (got: ${out.slice(0, 400)})`)

  const summary = JSON.parse(line.slice('RESULT '.length))
  t.ok(summary, 'a summary is returned — null is what made this a false green')
  t.is(summary.failed, 1, 'the module is reported as failed')
  t.is(summary.passed, 0)
  t.ok(
    summary.error && /Failed to load vision model/.test(summary.error.message),
    'the original error is carried through for the log'
  )
  t.is(code, 1, 'and the process still exits non-zero')
})
