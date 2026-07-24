const test = require('brittle')
const Supervisor = require('..')

test('boots in dependency order, deps resolve via get', async (t) => {
  const sup = new Supervisor()
  const log = []
  sup.add('b', {
    deps: ['a'],
    start: ({ get }) => {
      log.push('b:' + get('a'))
      return 'B'
    }
  })
  sup.add('a', {
    start: () => {
      log.push('a')
      return 'A'
    }
  })
  await sup.ready()
  t.teardown(() => sup.close())

  t.alike(log, ['a', 'b:A'])
  t.is(sup.get('a'), 'A')
  t.is(sup.get('b'), 'B')
})

test('teardown is reverse start order, independent children close per add order', async (t) => {
  const sup = new Supervisor()
  const log = []
  const child = (name, deps) => ({
    deps,
    start: () => name,
    stop: () => {
      log.push(name)
    }
  })
  sup.add('core', child('core'))
  sup.add('engine', child('engine', ['core']))
  sup.add('harness', child('harness'))
  sup.add('assistant', child('assistant', ['engine', 'harness', 'core']))
  await sup.ready()
  await sup.close()

  t.alike(log, ['assistant', 'engine', 'harness', 'core'])
  t.ok(log.indexOf('harness') < log.indexOf('core'), 'harness closes before core')
})

test('get throws unless running', async (t) => {
  const sup = new Supervisor()
  sup.add('a', { start: () => 'A' })
  t.exception(() => sup.get('a'), /not running/)
  t.exception(() => sup.get('nope'), /not running/)
  await sup.ready()
  t.is(sup.get('a'), 'A')
  await sup.close()
  t.exception(() => sup.get('a'), /not running/)
})

test('duplicate child registration preserves the original child', async (t) => {
  const sup = new Supervisor()
  let factoryCalls = 0
  sup.add('a', { start: () => 'original' })

  t.exception(
    () =>
      sup.add('a', () => {
        factoryCalls++
        return { start: () => 'replacement' }
      }),
    /Duplicate child: a/
  )
  t.is(factoryCalls, 0, 'the rejected factory was not invoked')

  await sup.ready()
  t.teardown(() => sup.close())
  t.is(sup.get('a'), 'original')
})

test('child registration is rejected while ready is pending', async (t) => {
  const sup = new Supervisor()
  let releaseStart = null
  let notifyStarted = null
  let factoryCalls = 0
  const started = new Promise((resolve) => (notifyStarted = resolve))
  sup.add('a', {
    start: () => {
      notifyStarted()
      return new Promise((resolve) => (releaseStart = resolve))
    }
  })

  const booting = sup.ready()
  await started
  t.exception(
    () =>
      sup.add('b', () => {
        factoryCalls++
        return { start: () => 'B' }
      }),
    /Cannot add children after startup/
  )
  t.is(factoryCalls, 0, 'the rejected factory was not invoked')

  releaseStart('A')
  await booting
  await sup.close()
})

test('child registration is rejected after ready completes', async (t) => {
  const sup = new Supervisor()
  let factoryCalls = 0
  await sup.ready()
  t.teardown(() => sup.close())

  t.exception(
    () =>
      sup.add('a', () => {
        factoryCalls++
        return { start: () => 'A' }
      }),
    /Cannot add children after startup/
  )
  t.is(factoryCalls, 0, 'the rejected factory was not invoked')
})

test('close is single-flight and idempotent', async (t) => {
  const sup = new Supervisor()
  let stops = 0
  sup.add('a', {
    start: () => 'A',
    stop: () => {
      stops++
    }
  })
  await sup.ready()
  await Promise.all([sup.close(), sup.close()])
  await sup.close()
  t.is(stops, 1)
})

test('unknown dep and cycle fail ready', async (t) => {
  const sup = new Supervisor()
  sup.add('a', { deps: ['ghost'], start: () => 'A' })
  await t.exception(() => sup.ready(), /Unknown dep/)

  const cyclic = new Supervisor()
  cyclic.add('a', { deps: ['b'], start: () => 'A' })
  cyclic.add('b', { deps: ['a'], start: () => 'B' })
  await t.exception(() => cyclic.ready(), /cycle/)
})

test('start throw during boot fails ready and unwinds started children', async (t) => {
  const sup = new Supervisor()
  const log = []
  sup.add('a', {
    start: () => 'A',
    stop: () => {
      log.push('a')
    }
  })
  sup.add('b', {
    deps: ['a'],
    start: () => {
      throw new Error('boom')
    }
  })
  await t.exception(() => sup.ready(), /boom/)
  t.alike(log, ['a'])
  await sup.close()
  t.alike(log, ['a'])
})

test('slow stop emits stall and still completes', async (t) => {
  const sup = new Supervisor({ stallTimeout: 20 })
  let release = null
  sup.add('a', {
    start: () => 'A',
    stop: () => new Promise((resolve) => (release = resolve))
  })
  await sup.ready()

  const stalled = new Promise((resolve) => sup.once('stall', resolve))
  const closing = sup.close()
  t.alike(await stalled, { name: 'a' })
  release()
  await closing
  t.pass('close completed after release')
})

test('slow start emits stall and still completes', async (t) => {
  const sup = new Supervisor({ stallTimeout: 20 })
  let release = null
  sup.add('a', { start: () => new Promise((resolve) => (release = resolve)) })
  t.teardown(() => sup.close())

  const stalled = new Promise((resolve) => sup.once('stall', resolve))
  const booting = sup.ready()
  t.alike(await stalled, { name: 'a' }, 'a start that neither readies nor dies surfaces a stall')
  release('A')
  await booting
  t.pass('boot completed once the start unblocked')
})

test('close breaks a boot wedged before ready instead of deadlocking', async (t) => {
  const sup = new Supervisor({ stallTimeout: 20 })
  sup.add('a', { start: () => new Promise(() => {}) }) // loads but never readies, never dies

  sup.ready().catch(() => {}) // wedges on the hung start; rejects once close breaks it
  await new Promise((resolve) => sup.once('stall', resolve))
  await sup.close()
  t.is(sup.closed, true, 'close completed despite the wedged boot')
})

test('close breaks a restart wedged before ready', async (t) => {
  const sup = new Supervisor({ stallTimeout: 20, backoff: 1 })
  let live = 0
  let kill = null
  sup.add('a', {
    start: ({ onDeath }) => {
      live++
      if (live === 1) {
        kill = () => onDeath(new Error('boom'))
        return 'A' // first life readies
      }
      return new Promise(() => {}) // the restart wedges before ready
    }
  })
  await sup.ready()
  t.teardown(() => sup.close())

  const stalled = new Promise((resolve) => sup.once('stall', resolve))
  kill() // death → restart, whose start wedges
  await stalled
  await sup.close()
  t.is(sup.closed, true, 'close completed despite the wedged restart')
})

test('suspend reverse order, resume forward, only where declared', async (t) => {
  const sup = new Supervisor()
  const log = []
  sup.add('a', {
    start: () => 'A',
    suspend: () => log.push('suspend:a'),
    resume: () => log.push('resume:a')
  })
  sup.add('b', {
    deps: ['a'],
    start: () => 'B',
    suspend: () => log.push('suspend:b'),
    resume: () => log.push('resume:b')
  })
  sup.add('c', { deps: ['b'], start: () => 'C' })
  await sup.ready()
  t.teardown(() => sup.close())

  await sup.suspend()
  await sup.resume()
  t.alike(log, ['suspend:b', 'suspend:a', 'resume:a', 'resume:b'])
})

test('suspend is not parked behind a backoff sleep, resume revives the parked child', async (t) => {
  const sup = new Supervisor()
  let kill = null
  const log = []
  sup.add('a', {
    backoff: 60_000,
    start({ onDeath }) {
      kill = onDeath
      return 'A'
    },
    stop: noop
  })
  sup.add('b', {
    start: () => 'B',
    suspend: () => log.push('suspend'),
    resume: () => log.push('resume')
  })
  await sup.ready()
  t.teardown(() => sup.close())

  kill(new Error('crashed'))
  await new Promise((resolve) => sup.once('child-restarting', resolve))
  const before = Date.now()
  await sup.suspend()
  t.ok(Date.now() - before < 5_000, 'suspend completed without waiting out the backoff')
  t.alike(log, ['suspend'])
  t.is(sup.inspect()[0].state, 'stopped', 'the restart parked while suspended')

  await sup.resume()
  t.alike(log, ['suspend', 'resume'])
  t.is(sup.inspect()[0].state, 'running', 'resume revived the parked child')
  t.is(sup.inspect()[0].lives, 2)
})

test('suspend linger delays the hooks, then runs them', async (t) => {
  const sup = new Supervisor()
  const log = []
  sup.add('a', {
    start: () => 'A',
    suspend: () => log.push('suspend'),
    resume: () => log.push('resume')
  })
  await sup.ready()
  t.teardown(() => sup.close())

  await sup.suspend({ linger: 20 })
  t.alike(log, ['suspend'], 'hooks ran after the linger window')
  await sup.resume()
  t.alike(log, ['suspend', 'resume'])
})

test('a resume inside the linger window coalesces the suspend — hooks never fire', async (t) => {
  const sup = new Supervisor()
  const log = []
  sup.add('a', {
    start: () => 'A',
    suspend: () => log.push('suspend'),
    resume: () => log.push('resume')
  })
  await sup.ready()
  t.teardown(() => sup.close())

  const coalesced = new Promise((resolve) => sup.once('suspend-coalesced', resolve))
  const suspending = sup.suspend({ linger: 60_000 })
  const before = Date.now()
  await sup.resume()
  await suspending
  await coalesced
  t.ok(Date.now() - before < 5_000, 'the suspend settled without waiting out the linger')
  t.alike(log, [], 'no suspend hook, and no resume hook for a suspend that never ran')
})

test('ready-resource handles open and close by convention', async (t) => {
  const sup = new Supervisor()
  const log = []
  sup.add('a', {
    start: () => ({
      ready: async () => {
        log.push('ready')
      },
      close: async () => {
        log.push('close')
      }
    })
  })
  await sup.ready()
  t.alike(log, ['ready'])
  await sup.close()
  t.alike(log, ['ready', 'close'])
})

test('inspect reports the live tree, including the spec state slice', async (t) => {
  const sup = new Supervisor()
  sup.add('a', {
    start: () => ({ count: 7 }),
    inspect: (handle) => ({ count: handle.count })
  })
  sup.add('b', { deps: ['a'], start: () => 'B' })
  await sup.ready()
  t.teardown(() => sup.close())

  const [a, b] = sup.inspect()
  t.alike(
    { name: a.name, state: a.state, lives: a.lives, deps: a.deps, deaths: a.deaths },
    { name: 'a', state: 'running', lives: 1, deps: [], deaths: 0 }
  )
  t.ok(typeof a.uptime === 'number' && a.uptime >= 0, 'uptime tracks the running incarnation')
  t.alike(a.info, { count: 7 }, "the spec's inspect slice is merged in")
  t.is(b.name, 'b')
  t.is(b.info, undefined)

  await sup.close()
  const [after] = sup.inspect()
  t.is(after.uptime, null, 'uptime is null when down')
  t.is(after.info, undefined, 'no state slice off a stopped child')
})

function noop() {}
