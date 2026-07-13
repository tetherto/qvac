const test = require('brittle')
const Thread = require('bare-thread')
const addon = require('.')

// The JsLogger singleton
// supports a single live owning env at a time. These tests exercise that
// contract using real concurrent envs spawned via bare-thread (each Thread is a
// separate js_env_t with its own uv_loop).

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForFlag(flags, index, timeout = 5000) {
  const start = Date.now()
  while (Atomics.load(flags, index) === 0) {
    if (Date.now() - start >= timeout) {
      throw new Error(`timed out waiting for flag ${index}`)
    }
    await delay(5)
  }
}

// A second, concurrently-live env calling setLogger must be rejected rather than
// silently hijacking the callback/handle (which leaks the first env's ref and
// leaves logger_async_ bound to the wrong loop).
//
// EXPECTED TO FAIL before the Option D fix: today the second setLogger returns
// undefined (no throw) and hijacks the singleton.
test('setLogger from a second live env is rejected', async (t) => {
  t.timeout(15000)

  const OWNS = 0
  const DONE = 1
  const flags = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT))

  const worker = new Thread('./worker-set-hold.js', { data: flags.buffer })

  // Wait until the worker env owns the logger, so our setLogger is genuinely
  // a second live env rather than a first install.
  await waitForFlag(flags, OWNS)

  let threw = false
  try {
    addon.setLogger((prio, msg) => {})
  } catch {
    threw = true
  }

  t.ok(threw, 'second live env setLogger throws instead of hijacking the singleton')

  // NOTE: if it did not throw (pre-fix), the main env has hijacked the singleton.
  // We deliberately do NOT releaseLogger() from the main env here: the async
  // handle belongs to the worker's loop, so closing it from this thread would be
  // a cross-thread uv_close. Let the worker release on its own loop below.

  Atomics.store(flags, DONE, 1)
  Atomics.notify(flags, DONE)
  worker.join()
})

// Regression guard: the reject must not break the supported sequential reload
// pattern (env A installs + releases, then env B installs). Passes before and
// after the fix; it exists so the reject logic can't over-reject legit reloads.
test('sequential handoff across envs keeps working', async (t) => {
  t.timeout(15000)

  const SET_OK = 0
  const RECV = 1

  async function runOwner() {
    const flags = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT))
    const worker = new Thread('./worker-set-release.js', { data: flags.buffer })
    worker.join()
    return { setOk: Atomics.load(flags, SET_OK), recv: Atomics.load(flags, RECV) }
  }

  const first = await runOwner()
  t.is(first.setOk, 1, 'first env installed the logger')
  t.ok(first.recv >= 1, 'first env received its own log')

  const second = await runOwner()
  t.is(second.setOk, 1, 'second env installed the logger after the first released')
  t.ok(second.recv >= 1, 'second env received its own log')
})

// releaseLogger from an env that does not own the logger must be a no-op: it
// must never tear down the live owner's callback/handle (symmetric with the
// setLogger reject). A worker env owns the logger and keeps logging after the
// main (non-owner) env calls releaseLogger.
//
// Before the Option D fix this would additionally close the worker's handle
// from the main thread (a cross-thread uv_close), so this doubles as a guard
// against that unsafe path.
test('releaseLogger from a non-owner env is a no-op', async (t) => {
  t.timeout(15000)

  const OWNS = 0
  const RELEASED = 1
  const RECV = 2
  const flags = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT))

  const worker = new Thread('./worker-owner-guard.js', { data: flags.buffer })

  // Wait until the worker env owns the logger.
  await waitForFlag(flags, OWNS)

  // The main env is not the owner; this must leave the worker's logger intact.
  addon.releaseLogger()

  // Let the worker emit + deliver a log now that the non-owner release happened.
  Atomics.store(flags, RELEASED, 1)
  Atomics.notify(flags, RELEASED)
  worker.join()

  t.ok(
    Atomics.load(flags, RECV) >= 1,
    'owner still received its log after a non-owner releaseLogger'
  )
})

// The supported reload path: an owning env is torn down WITHOUT calling
// releaseLogger (onEnvTeardown is expected to clear the singleton), and then a
// brand-new env must be able to install the logger and receive its own logs.
// This asserts the positive outcome that teardown.test.js only exercises
// implicitly (it asserts survival, not that the next env can still log).
test('new env installs the logger after a prior env torn down without releaseLogger', async (t) => {
  t.timeout(15000)

  const OWNS = 0
  const firstFlags = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const first = new Thread('./worker-set-norelease.js', { data: firstFlags.buffer })

  // Wait until the first env owns the logger (and has logged), then tear it down
  // without any releaseLogger. join() guarantees its onEnvTeardown has run.
  await waitForFlag(firstFlags, OWNS)
  first.terminate()
  first.join()

  // A brand-new env must now install cleanly and deliver its own log.
  const SET_OK = 0
  const RECV = 1
  const secondFlags = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT))
  const second = new Thread('./worker-set-release.js', { data: secondFlags.buffer })
  second.join()

  t.is(Atomics.load(secondFlags, SET_OK), 1, 'new env installed the logger after unclean teardown')
  t.ok(Atomics.load(secondFlags, RECV) >= 1, 'new env received its own log')
})
