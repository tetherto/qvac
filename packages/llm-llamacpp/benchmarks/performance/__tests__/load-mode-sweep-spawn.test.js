'use strict'

// Regression tests for run 35778027044, where the darwin-x64 and linux-arm64
// legs each reported SUCCESS while producing 0 of 18 measurements.
//
// Three separate defects lined up to make that look like a clean run:
//   1. the probe was spawned as bare `bare`, absent from those two runners;
//   2. spawn-level errors (ENOENT) were dropped from the failure message,
//      because only result.stderr was read — which is undefined for ENOENT —
//      so every cell read `probe produced no result (exit null): `;
//   3. a leg where nothing loaded still exited 0.
//
// Each test below fails if its fix is reverted.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const Module = require('node:module')

const RUNNER = path.resolve(__dirname, '..', 'load-mode-sweep.js')
const SRC = fs.readFileSync(RUNNER, 'utf8')

// The runner calls main() on require, so compile it without the entry point.
function loadRunner(exportList) {
  const wrapped =
    SRC.replace(/\nmain\(\)[\s\S]*$/, '\n') + `\nmodule.exports = { ${exportList} }\n`
  const mod = new Module('load-mode-sweep-spawn-under-test')
  mod.paths = Module._nodeModulePaths(path.dirname(RUNNER))
  mod.filename = RUNNER
  mod._compile(wrapped, RUNNER)
  return mod.exports
}

test('resolution picks a candidate that actually executes', () => {
  const { resolveBareCommand } = loadRunner('resolveBareCommand')
  // Injected candidates, so this asserts on real execution rather than on how
  // the candidate list was spelled. `sh -c` stands in for a command processor.
  const { candidate, version } = resolveBareCommand([
    { command: 'definitely-missing-binary', prefix: [] },
    { command: 'sh', prefix: ['-c', 'echo 1.2.3 #'] }
  ])
  assert.strictEqual(candidate.command, 'sh', 'the runnable candidate is chosen')
  assert.strictEqual(version, '1.2.3')
})

test('a processor that runs but cannot find its target is rejected', () => {
  // The trap that made the previous attempt wrong: through a command processor
  // a missing inner command sets NO spawn error and exits non-zero, so
  // "no error" is not proof the tool ran. Verified: sh -c 'missing' -> 127.
  const { resolveBareCommand } = loadRunner('resolveBareCommand')
  const probe = spawnSync('sh', ['-c', 'definitely-missing-binary --version'], { encoding: 'utf8' })
  assert.strictEqual(probe.error, undefined, 'precondition: the processor itself spawns fine')
  assert.notStrictEqual(probe.status, 0, 'precondition: but the inner command fails')

  const { candidate } = resolveBareCommand([
    { command: 'sh', prefix: ['-c', 'definitely-missing-binary'] },
    { command: 'sh', prefix: ['-c', 'echo 9.9.9 #'] }
  ])
  assert.deepStrictEqual(
    candidate.prefix,
    ['-c', 'echo 9.9.9 #'],
    'a non-zero exit must not be accepted as a working invocation'
  )
})

test('a candidate that exits cleanly but prints nothing is rejected', () => {
  const { resolveBareCommand } = loadRunner('resolveBareCommand')
  const { candidate } = resolveBareCommand([
    { command: 'sh', prefix: ['-c', 'true #'] },
    { command: 'sh', prefix: ['-c', 'echo 4.5.6 #'] }
  ])
  assert.deepStrictEqual(candidate.prefix, ['-c', 'echo 4.5.6 #'], 'silence is not a version')
})

test('nothing runnable throws, naming every candidate tried', () => {
  const { resolveBareCommand } = loadRunner('resolveBareCommand')
  assert.throws(
    () => resolveBareCommand([{ command: 'definitely-missing-binary', prefix: ['--x'] }]),
    (err) => /Cannot invoke bare\. Tried:/.test(err.message) &&
             /definitely-missing-binary --x \(ENOENT\)/.test(err.message),
    'must fail loudly with the full list rather than failing every cell one by one'
  )
})

test('Windows routes npm shims through the command processor, POSIX does not', () => {
  // Node refuses to spawn a .bat/.cmd without a shell (CVE-2024-27980 fix), so
  // naming `bare.cmd` directly cannot work — the shim needs the processor.
  const { bareCandidates } = loadRunner('bareCandidates')
  const win = bareCandidates('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })

  for (const c of win) {
    const shim = [c.command, ...c.prefix].find((t) => String(t).endsWith('.cmd'))
    if (shim) {
      assert.strictEqual(c.command, 'C:\\Windows\\system32\\cmd.exe', 'shims go through ComSpec')
      assert.deepStrictEqual(c.prefix.slice(0, 3), ['/d', '/s', '/c'], 'processor flags present')
    }
  }
  assert.ok(win.some((c) => c.command === 'bare.exe'), 'a real executable is tried directly')
  assert.ok(
    win.some((c) => [c.command, ...c.prefix].join(' ').includes('npx.cmd')),
    'the npx shim remains available'
  )
  assert.ok(bareCandidates('win32', {}).every((c) => c.command), 'falls back to cmd.exe with no ComSpec')

  assert.deepStrictEqual(bareCandidates('linux', {}), [
    { command: 'bare', prefix: [] },
    { command: 'npx', prefix: ['--yes', 'bare'] }
  ], 'no processor indirection off Windows')
})

test('a global bare is preferred and npx is the last resort on every platform', () => {
  // The workflow installs a global bare via setup-bare-tooling. npx stays only
  // for a local shell without one: it re-resolves the package on EVERY
  // invocation (~2s warm, far worse cold) and the sweep spawns one process per
  // sample — that is what cost darwin-x64 40 minutes for three cells.
  const { bareCandidates } = loadRunner('bareCandidates')
  for (const platform of ['linux', 'darwin', 'win32']) {
    const labels = bareCandidates(platform, { ComSpec: 'cmd.exe' }).map(
      (c) => [c.command, ...c.prefix].join(' ')
    )
    const firstNpx = labels.findIndex((l) => l.includes('npx'))
    assert.notStrictEqual(firstNpx, -1, `${platform}: npx remains available`)
    assert.strictEqual(firstNpx, labels.length - 1, `${platform}: npx is tried LAST`)
    assert.ok(
      labels.slice(0, firstNpx).some((l) => l.includes('bare')),
      `${platform}: a direct bare invocation is tried first`
    )
  }
})

test('the resolved invocation is memoised, not re-probed per cell', () => {
  const { bareCommand } = loadRunner('bareCommand')
  const probe = spawnSync('bare', ['--version'], { encoding: 'utf8' })
  if (probe.error) return // no bare on this host
  const first = bareCommand()
  const realPath = process.env.PATH
  try {
    process.env.PATH = '/nonexistent'
    assert.strictEqual(bareCommand(), first, 'resolve once, not once per probe')
  } finally {
    process.env.PATH = realPath
  }
})

test('a spawn-level failure names its cause instead of a blank tail', () => {
  const { describeProbeFailure } = loadRunner('describeProbeFailure')

  // The real ENOENT shape: status null, stderr undefined, cause only in .error.
  const enoent = describeProbeFailure({ status: null, stderr: undefined, error: { code: 'ENOENT' } })
  assert.match(enoent, /ENOENT/, 'the spawn error must be named')
  assert.doesNotMatch(
    enoent,
    /^probe produced no result \(exit null\): $/,
    'must not be the blank message two CI legs produced'
  )

  // A probe that really ran and failed still reports its stderr tail.
  const crashed = describeProbeFailure({ status: 1, stderr: 'line1\nboom: bad model\n' })
  assert.match(crashed, /boom: bad model/, 'stderr tail survives')
  assert.match(crashed, /exit 1/, 'exit status survives')
  assert.doesNotMatch(crashed, /undefined/, 'no undefined leaks in when there is no spawn error')
})

test('a record is usable only if it measured the device it asked for', () => {
  const { isUsableRecord } = loadRunner('isUsableRecord')
  const good = { status: 'measured', loadMsMedian: 700, requestedDevice: 'gpu', backendDevice: 'gpu' }
  assert.strictEqual(isUsableRecord(good), true)
  assert.strictEqual(
    isUsableRecord({ ...good, status: 'failed' }),
    false,
    'a failed probe is not a measurement'
  )
  assert.strictEqual(
    isUsableRecord({ ...good, loadMsMedian: null }),
    false,
    'a record with no load time is not a measurement'
  )
  assert.strictEqual(
    isUsableRecord({ ...good, backendDevice: 'cpu' }),
    false,
    'a GPU cell that silently ran on CPU is the row the renderer calls non-comparable'
  )
})

test('a leg is no-data when every cell failed, and when every cell fell back', () => {
  const { isUsableRecord } = loadRunner('isUsableRecord')
  const allFailed = Array.from({ length: 18 }, () => ({
    status: 'failed', loadMsMedian: null, requestedDevice: 'cpu', backendDevice: null
  }))
  assert.strictEqual(allFailed.filter(isUsableRecord).length, 0, 'darwin-x64 / linux-arm64 shape')

  // The subtler one: every probe succeeded, but the whole leg ran on a backend
  // nobody asked for. Counting these would let it report success on no data.
  const allMismatched = Array.from({ length: 18 }, () => ({
    status: 'measured', loadMsMedian: 700, requestedDevice: 'gpu', backendDevice: 'cpu'
  }))
  assert.strictEqual(allMismatched.filter(isUsableRecord).length, 0, 'silent CPU fallback is not data')

  const mixed = [...allFailed, { status: 'measured', loadMsMedian: 700, requestedDevice: 'gpu', backendDevice: 'gpu' }]
  assert.strictEqual(mixed.filter(isUsableRecord).length, 1, 'one real cell is enough to be data')
})

test('main() gates its exit code on the usable-record predicate', () => {
  // Behaviour above; this only pins that the guard consults the predicate
  // rather than re-deriving a looser rule inline.
  assert.match(SRC, /const measured = records\.filter\(isUsableRecord\)/)
  assert.match(SRC, /if \(measured\.length === 0\) \{[\s\S]*?process\.exitCode = 1/)
})

test('a cell that ran on a different backend is classified, not counted as measured', () => {
  const { classify, isUsableRecord } = loadRunner('classify, isUsableRecord')
  const samples = [700, 710, 705]

  assert.strictEqual(classify({ device: 'gpu', mode: 'auto' }, samples, 'gpu'), 'measured')
  assert.strictEqual(
    classify({ device: 'gpu', mode: 'auto' }, samples, 'cpu'),
    'backend-mismatch',
    'a GPU request served by the CPU is not a GPU measurement'
  )
  // Mismatch outranks the dio alias: knowing it ran on the wrong device
  // matters more than knowing the flag is inert.
  assert.strictEqual(classify({ device: 'gpu', mode: 'dio' }, samples, 'cpu'), 'backend-mismatch')
  assert.strictEqual(classify({ device: 'gpu', mode: 'dio' }, samples, 'gpu'), 'inert')
  // Unknown is NOT agreement. Every darwin-x64 cell in run 35810927805 came
  // back with a null backend and was published as a measured GPU row.
  assert.strictEqual(
    classify({ device: 'gpu', mode: 'auto' }, samples, null),
    'backend-unverified',
    'an unconfirmed backend cannot support a per-device verdict'
  )

  assert.strictEqual(
    isUsableRecord({ status: 'backend-mismatch', loadMsMedian: 700, requestedDevice: 'gpu', backendDevice: 'cpu' }),
    false,
    'a mismatched cell must not satisfy the no-data guard'
  )
  assert.strictEqual(
    isUsableRecord({ status: 'backend-unverified', loadMsMedian: 700, requestedDevice: 'gpu', backendDevice: null }),
    false,
    'an unverified backend must not satisfy the no-data guard either'
  )
})

test('each rejection reason is reported accurately, not collapsed', () => {
  const { resolveBareCommand } = loadRunner('resolveBareCommand')
  let message = ''
  try {
    resolveBareCommand([
      // Exits non-zero but DOES print — must not be blamed for missing output.
      { command: 'sh', prefix: ['-c', 'echo 1.0.0; exit 3'] },
      // Exits non-zero and prints nothing.
      { command: 'sh', prefix: ['-c', 'exit 4'] },
      // Exits cleanly but prints nothing.
      { command: 'sh', prefix: ['-c', 'true #'] },
      { command: 'definitely-missing-binary', prefix: [] }
    ])
    assert.fail('expected a throw')
  } catch (err) {
    message = err.message
  }

  assert.match(message, /echo 1\.0\.0; exit 3 \(exit 3\)/, 'a printing candidate is not called silent')
  assert.doesNotMatch(
    message,
    /echo 1\.0\.0; exit 3 \(exit 3, no output\)/,
    'output that existed must not be reported as missing'
  )
  assert.match(message, /exit 4 \(exit 4, no output\)/, 'silent non-zero says so')
  assert.match(message, /true # \(exit 0 but printed no version\)/, 'clean-but-silent is its own reason')
  assert.match(message, /definitely-missing-binary \(ENOENT\)/, 'spawn errors keep their code')
})

test('a leg that could not confirm any backend is no-data, not a GPU result', () => {
  // The darwin-x64 shape from run 35810927805: every probe loaded fine and
  // returned a time, and not one could say which device ran it.
  const { isUsableRecord } = loadRunner('isUsableRecord')
  const unverified = Array.from({ length: 3 }, () => ({
    status: 'backend-unverified', loadMsMedian: 2602.2, requestedDevice: 'gpu', backendDevice: null
  }))
  assert.strictEqual(unverified.filter(isUsableRecord).length, 0)
})

test('a probe that threw is distinguished from a backend that cannot be read', () => {
  // These look identical downstream — both leave backendDevice null — but one
  // is a harness fault and the other a platform property. Conflating them is
  // how `generationParams.n_predict`, which the API rejects outright, was
  // read as "iOS cannot report its backend" across an entire qualifying run.
  const { classify, isUsableRecord } = loadRunner('classify, isUsableRecord')
  const samples = [700, 710, 705]
  const cell = { device: 'gpu', mode: 'auto' }

  assert.strictEqual(
    classify(cell, samples, null, 'generationParams has unknown key: n_predict'),
    'backend-probe-failed',
    'a thrown probe is a harness fault'
  )
  assert.strictEqual(
    classify(cell, samples, null, null),
    'backend-unverified',
    'a probe that ran and reported nothing is a platform gap'
  )
  // A thrown probe outranks even a matching backend: nothing it reports is trustworthy.
  assert.strictEqual(classify(cell, samples, 'gpu', 'boom'), 'backend-probe-failed')

  assert.strictEqual(
    isUsableRecord({
      status: 'backend-probe-failed', loadMsMedian: 700,
      requestedDevice: 'gpu', backendDevice: 'gpu'
    }),
    false,
    'a harness fault is never usable data'
  )
})
